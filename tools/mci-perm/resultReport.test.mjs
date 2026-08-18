/**
 * 結果彙整與落檔的測試。
 *
 * ⚠ 這裡的姓名全是為了測試而編的，不是真實人員。
 *
 * 執行：npm run tool:mci:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OUTCOME } from './grantFlow.mjs';
import { summarize, writeResultReport } from './resultReport.mjs';
import { maskName } from './logger.mjs';

const RESULTS = [
  { unit: '測試甲分隊', name: '測試甲', outcome: OUTCOME.granted, step: '完成', detail: '已設定並按下確定' },
  { unit: '測試甲分隊', name: '測試乙', outcome: OUTCOME.notFound, step: '步驟4', detail: '查詢結果 0 筆' },
  { unit: '測試乙分隊', name: '測試丙', outcome: OUTCOME.multiple, step: '步驟4', detail: '查到 2 個人' },
  { unit: '測試乙分隊', name: '測試丁', outcome: OUTCOME.failed, step: '步驟6', detail: '找不到確定按鈕' },
];

test('統計各種結果各有幾筆', () => {
  const summary = summarize(RESULTS);
  assert.equal(summary.total, 4);
  assert.equal(summary.byOutcome[OUTCOME.granted], 1);
  assert.equal(summary.byOutcome[OUTCOME.notFound], 1);
});

test('「查無此人」「不只一人」「失敗」都要列進需人工接手', () => {
  const summary = summarize(RESULTS);
  assert.equal(summary.needsAttention.length, 3);
  assert.ok(!summary.needsAttention.some((result) => result.outcome === OUTCOME.granted));
});

test('試跑成功不算需要接手（沒按確定是預期行為，不是問題）', () => {
  const summary = summarize([
    { unit: '測試甲分隊', name: '測試甲', outcome: OUTCOME.dryRun, step: '步驟6', detail: '沒按確定' },
  ]);
  assert.equal(summary.needsAttention.length, 0);
});

test('結果檔寫得出來，且分得出試跑與正式執行', async (t) => {
  // 寫到暫存資料夾，不動到工具的 out/。
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mci-perm-test-'));
  const config = await import('./config.mjs');
  const originalDir = config.PATHS.resultDir;
  config.PATHS.resultDir = tempDir;
  t.after(async () => {
    config.PATHS.resultDir = originalDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = await writeResultReport(RESULTS, { execute: false, now: new Date('2026-08-18T09:30:00') });
  const content = await fs.readFile(filePath, 'utf8');
  assert.match(content, /試跑（沒有按確定/);
  assert.match(content, /需要人工接手的/);
  // 檔案本身要看得到真名（承辦人得知道要補做誰），但必須附上不可外傳的警語。
  assert.ok(content.includes('測試丁'));
  assert.match(content, /屬個人資料/);
});

test('終端機用的遮蔽只留姓氏', () => {
  assert.equal(maskName('測試甲'), '測○○');
});
