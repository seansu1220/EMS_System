/**
 * 篩選說明 PDF 的測試。
 *
 * 釘住的是會「默默失效」的地方：
 *   1. 原始檔被改名或刪掉 → 月報表照跑，只是少了說明
 *   2. 說明名稱沒列進產出檔名單 → 月報表資料夾收不進去，PDF 留在 out/report/ 沒人看到
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildGuideHtml, guidePdfFileName } from './guidePdf.mjs';
import { GUIDES } from './config.mjs';
import { MONTHLY_OUTPUT_NAMES, monthOfOutputFile } from './fileNames.mjs';
import { shouldBundle } from './bundle.mjs';

const MONTH = { start: '2026-09-01', end: '2026-09-30', label: '2026-09' };

test('組出的網頁有標題、樣式與本文', () => {
  const html = buildGuideHtml('心電圖傳輸率怎麼篩', '<h1>本文</h1>', 'body{color:red}');
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title>心電圖傳輸率怎麼篩<\/title>/);
  assert.match(html, /<style>body\{color:red\}<\/style>/);
  assert.match(html, /<body><h1>本文<\/h1><\/body>/);
});

test('有月份時年月放在檔名最前面，沒有就只用名稱', () => {
  const guide = { name: '心電圖傳輸率怎麼篩', source: 'x.html' };
  assert.equal(guidePdfFileName(guide, MONTH), '2026-09-心電圖傳輸率怎麼篩.pdf');
  assert.equal(guidePdfFileName(guide, null), '心電圖傳輸率怎麼篩.pdf');
});

test('每一份說明的原始檔與共用樣式都在', async () => {
  await fs.access(path.join(GUIDES.sourceDir, GUIDES.styleFile));
  for (const guide of GUIDES.items) {
    await fs.access(path.join(GUIDES.sourceDir, guide.source));
  }
});

test('每一份說明都認得出是這個月的產出，會收進月報表資料夾', () => {
  for (const guide of GUIDES.items) {
    assert.ok(MONTHLY_OUTPUT_NAMES.includes(guide.name), `${guide.name} 沒有列進 MONTHLY_OUTPUT_NAMES`);
    const fileName = guidePdfFileName(guide, MONTH);
    assert.equal(monthOfOutputFile(fileName), '2026-09');
    assert.equal(shouldBundle(fileName, '2026-09'), true);
  }
});

test('使用者自己放的 PDF 不會被當成產出', () => {
  assert.equal(monthOfOutputFile('2026-09-分隊回覆.pdf'), null);
});
