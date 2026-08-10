/**
 * 執行報告的測試。寫進暫存目錄再讀回來檢查內容，不動使用者的 out/。
 *
 * 釘住的是使用者 2026-08-10 的要求：簡短、有排版、
 * 而且**「要你確認的事」要講得出「發生什麼事 → 你要做什麼」**，不是丟一個數字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeRunSummary } from './ekgSummary.mjs';
import { PATHS } from './config.mjs';
import { VERDICT } from './ekgVerify.mjs';

const MONTH = { start: '2026-07-01', end: '2026-07-31', label: '2026-07' };

const BASE = {
  monthRange: MONTH,
  denominatorCounts: new Map([['平鎮分隊', 10], ['龍岡分隊', 11]]),
  numeratorCounts: new Map([['平鎮分隊', 8], ['龍岡分隊', 10]]),
  sourceCounts: { ekgChecked: 242, twelveLead: 284, union: 20 },
  outcomes: [],
  appeals: null,
  files: ['心電圖到院前傳輸率-2026-07.xlsx（正式報表）'],
};

/**
 * 產報告時把 stdout 靜音（比照 `loggerLive.test.mjs`）。
 *
 * ⚠ 不靜音的話 `node --test` 會間歇性整個測試檔失敗，錯誤是
 * `Unable to deserialize cloned data` ——測試 runner 用子行程的 stdout 傳結果，
 * 我們 logger 印出來的東西會把那個通道弄亂。症狀是測試總數每次都不一樣。
 */
async function quietly(run) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
  }
}

/** 寫一份報告並讀回內容，順便清掉檔案。 */
async function render(overrides = {}) {
  const filePath = await quietly(() => writeRunSummary({ ...BASE, ...overrides }));
  const text = await fs.readFile(filePath, 'utf8');
  await fs.rm(filePath, { force: true });
  return text;
}

test('報告落在 out/internal/，不是要發給分隊的 out/report/', async () => {
  const filePath = await quietly(() => writeRunSummary(BASE));
  assert.equal(path.dirname(filePath), PATHS.internalDir);
  assert.match(path.basename(filePath), /^心電圖執行報告-2026-07\.md$/);
  await fs.rm(filePath, { force: true });
});

test('先講結論數字：分母、分子、傳輸率', async () => {
  const text = await render();
  assert.match(text, /\| 分母（EKG或12導程） \| \*\*21\*\* \|/);
  assert.match(text, /\| 分子（到院前傳出） \| \*\*18\*\* \|/);
  assert.match(text, /85\.7%/);
});

test('分母比原始聯集多時，要講清楚多的是申訴補的', async () => {
  const text = await render();
  assert.match(text, /申訴另補 1 件/);
});

test('沒事要確認時就直接寫沒有，不留一個空標題', async () => {
  const text = await render();
  assert.match(text, /## 要你確認的事\n\n沒有。這次全部都處理完了。/);
});

test('判定不出來的要寫成「怎麼了 → 你要做什麼」，並逐件列出', async () => {
  const text = await render({
    outcomes: [{
      temsis: '2026070510100322073401', squad: '大竹分隊', verdict: VERDICT.unknown,
      reason: '以 TEMSIS 查不到案件', caseDate: '2026/07/05 22:07:34', arrival: null, upload: null,
    }],
  });
  assert.match(text, /\*\*1 件判定不出來\*\*/);
  assert.match(text, /請填進申訴表/);
  // 逐件明細那一段，TEMSIS 只寫末 4 碼。
  assert.match(text, /## 判定不出來的案件/);
  assert.match(text, /大竹分隊 \| 2026\/07\/05 22:07:34 \| \*+3401/);
  assert.ok(!text.includes('2026070510100322073401'), '摘要不寫完整 TEMSIS');
});

test('申訴表填錯的地方要指出是第幾列', async () => {
  const text = await render({
    appeals: {
      numerator: new Map([['平鎮分隊', 1]]),
      denominator: new Map(),
      results: [{
        appeal: { squad: '平鎮分隊', caseDate: '2026/7/20 20:20', temsis: '2026072010100320182701' },
        outcome: '補進分子',
        matchedBy: 'TEMSIS',
        reason: '依申訴改列為到院前傳出',
      }],
      skipped: { example: 1, outOfRange: 21, noDate: ['30'], noSquad: ['12'] },
    },
  });
  assert.match(text, /第 30 列的\*\*案件日期看不出來/);
  assert.match(text, /第 12 列的\*\*救護車編號推不出分隊/);
  assert.match(text, /\| 平鎮分隊 \| 2026\/7\/20 20:20 \| \*+2701 \| 補進分子 \| TEMSIS \|/);
});

test('沒有申訴表時要講明，不要讓人以為漏跑了', async () => {
  const text = await render({ appeals: null });
  assert.match(text, /這次沒有讀申訴表/);
});

test('報告本身要提醒不能發給分隊', async () => {
  const text = await render();
  assert.match(text, /不要發給分隊/);
});
