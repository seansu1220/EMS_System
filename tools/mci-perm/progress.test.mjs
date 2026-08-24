/**
 * 開通進度（做過的人記下來、下次接著跑）的測試。
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
import {
  appendProgress,
  countByOutcome,
  entryKey,
  isDone,
  legacyEntryKey,
  loadProgress,
  splitByProgress,
} from './progress.mjs';

const 甲 = { unit: '大溪分隊', name: '測試甲', lineNumber: 2 };
const 乙 = { unit: '中壢分隊', name: '測試乙', lineNumber: 3 };

test('同名但不同單位是兩個人', () => {
  assert.notEqual(entryKey({ unit: '大溪分隊', name: '測試甲' }), entryKey({ unit: '中壢分隊', name: '測試甲' }));
});

test('只有真的成功才算做完', () => {
  assert.equal(isDone({ outcome: OUTCOME.granted }), true);
  assert.equal(isDone({ outcome: OUTCOME.alreadyGranted }), true);
});

test('失敗、查無此人、查到不只一人都要再試一次', () => {
  // 這些多半是暫時狀況（掉線、名單打錯後修正、系統當下卡住），
  // 直接跳過會讓人默默漏掉權限。
  assert.equal(isDone({ outcome: OUTCOME.failed }), false);
  assert.equal(isDone({ outcome: OUTCOME.notFound }), false);
  assert.equal(isDone({ outcome: OUTCOME.multiple }), false);
  assert.equal(isDone(undefined), false);
});

test('試跑不算做完（沒有真的開通）', () => {
  assert.equal(isDone({ outcome: OUTCOME.dryRun }), false);
});

test('依進度分成「要做的」與「已完成的」', () => {
  const progress = new Map([[entryKey(甲), { outcome: OUTCOME.granted }]]);
  const { todo, skipped } = splitByProgress([甲, 乙], progress);
  assert.deepEqual(todo.map((entry) => entry.name), ['測試乙']);
  assert.equal(skipped.length, 1);
});

test('同一個單位裡遮蔽後同名、但帳號不同，是兩個人', () => {
  // 2026-08-24 實跑踩到的：第二救災救護大隊有兩位都顯示成「李O城」。
  // 鍵若不含帳號，其中一位會被當成另一位做過了而默默跳過。
  const 前者 = { unit: '第二救災救護大隊', name: '李O城', rowAccount: 'A1*****621' };
  const 後者 = { unit: '第二救災救護大隊', name: '李O城', rowAccount: 'A1*****564' };
  assert.notEqual(entryKey(前者), entryKey(後者));
});

test('舊進度檔（沒有帳號的鍵）照樣算數，不必整份重跑', () => {
  const 甲有帳號 = { ...甲, rowAccount: 'A1*****621' };
  const progress = new Map([[legacyEntryKey(甲有帳號), { outcome: OUTCOME.granted }]]);
  const { todo, skipped } = splitByProgress([甲有帳號, 乙], progress);
  assert.deepEqual(todo.map((entry) => entry.name), ['測試乙']);
  assert.equal(skipped.length, 1);
});

test('名單裡同名不只一位時，舊鍵一律不採用（寧可重做也不能漏做）', () => {
  // 舊鍵不含帳號，兩位同名者會共用同一筆紀錄：
  // 採用它就等於「另一位沒做過卻被當成做完了」，那是默默漏開權限。
  const 前者 = { unit: '第二救災救護大隊', name: '李O城', rowAccount: 'A1*****621' };
  const 後者 = { unit: '第二救災救護大隊', name: '李O城', rowAccount: 'A1*****564' };
  const progress = new Map([[legacyEntryKey(前者), { outcome: OUTCOME.granted }]]);
  const { todo, skipped } = splitByProgress([前者, 後者], progress);
  assert.equal(todo.length, 2, '兩位都要再跑一次');
  assert.equal(skipped.length, 0);
});

test('新鍵的紀錄優先於舊鍵', () => {
  const 前者 = { unit: '第二救災救護大隊', name: '李O城', rowAccount: 'A1*****621' };
  const 後者 = { unit: '第二救災救護大隊', name: '李O城', rowAccount: 'A1*****564' };
  const progress = new Map([[entryKey(前者), { outcome: OUTCOME.granted }]]);
  const { todo, skipped } = splitByProgress([前者, 後者], progress);
  assert.deepEqual(todo.map((entry) => entry.rowAccount), ['A1*****564']);
  assert.equal(skipped.length, 1);
});

test('寫進去再讀回來，接得上', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mci-progress-'));
  const file = path.join(dir, '進度.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await appendProgress(file, 甲, { outcome: OUTCOME.granted, detail: '已設定' });
  await appendProgress(file, 乙, { outcome: OUTCOME.failed, detail: '按不到設定' });

  const progress = await loadProgress(file);
  assert.equal(progress.size, 2);
  assert.equal(progress.get(entryKey(甲)).outcome, OUTCOME.granted);

  const { todo } = splitByProgress([甲, 乙], progress);
  assert.deepEqual(todo.map((entry) => entry.name), ['測試乙'], '上次失敗的要再試一次');
});

test('同一個人做兩次，以最後一次為準', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mci-progress-'));
  const file = path.join(dir, '進度.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await appendProgress(file, 甲, { outcome: OUTCOME.failed, detail: '第一次失敗' });
  await appendProgress(file, 甲, { outcome: OUTCOME.granted, detail: '重跑成功' });

  const progress = await loadProgress(file);
  assert.equal(progress.get(entryKey(甲)).outcome, OUTCOME.granted);
});

test('斷電只壞最後一行時，前面的進度仍然讀得回來', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mci-progress-'));
  const file = path.join(dir, '進度.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await appendProgress(file, 甲, { outcome: OUTCOME.granted, detail: '已設定' });
  await fs.appendFile(file, '{"key":"寫到一半就斷', 'utf8');

  const progress = await loadProgress(file);
  assert.equal(progress.size, 1, '為了壞掉的一行讓前面全部重跑完全不划算');
});

test('沒有進度檔時回傳空的，不當成錯誤', async () => {
  const progress = await loadProgress(path.join(os.tmpdir(), '不存在的進度檔.jsonl'));
  assert.equal(progress.size, 0);
});

test('統計各種結果各有幾筆', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mci-progress-'));
  const file = path.join(dir, '進度.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await appendProgress(file, 甲, { outcome: OUTCOME.granted, detail: '' });
  await appendProgress(file, 乙, { outcome: OUTCOME.alreadyGranted, detail: '' });
  const counts = countByOutcome(await loadProgress(file));
  assert.equal(counts[OUTCOME.granted], 1);
  assert.equal(counts[OUTCOME.alreadyGranted], 1);
});
