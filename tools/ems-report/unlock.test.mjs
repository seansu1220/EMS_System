/**
 * 解鎖流程的測試（用假的 frame 物件，不需要真的開瀏覽器）。
 *
 * 重點同 session.test.mjs：要**實際執行到函式內部**，
 * 語法檢查抓不到「用了沒 import 的常數」，只有真的跑過才會顯現。
 *
 * 另一個重點是釘住安全行為：**比對不到相符的 TEMSIS 時絕不可以挑一張來解**。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { locateUnlockTarget } from './unlock.mjs';
import { groupByRow, normalizeText } from './pageFinder.mjs';
import { getRecentRange } from './dateRange.mjs';
import { SITE } from './config.mjs';

/**
 * 造一個最小的假 page：只要能回傳一個假的內容框，
 * 且該 frame 的 evaluate() 回傳我們指定的配對結果即可。
 */
function createFakePage(pairsResult) {
  const frame = {
    name: () => SITE.frames.content,
    async evaluate() {
      return pairsResult;
    },
  };
  return { frames: () => [frame] };
}

test('案件內只有一張紀錄表時直接鎖定，不需要開紀錄表比對', async () => {
  const page = createFakePage({
    pairs: [{ recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄' }],
    recordCount: 1,
    unlockCount: 1,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => assert.fail('只有一張時不應該去開紀錄表'),
  });
  assert.equal(outcome.status, '已定位');
});

test('找不到解鎖按鈕時回報需人工處理', async () => {
  const page = createFakePage({ pairs: [], recordCount: 0, unlockCount: 0, unlockTexts: [] });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001');
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /找不到/);
});

test('有多個解鎖按鈕卻沒有可比對的紀錄表時，回報需人工處理', async () => {
  const page = createFakePage({ pairs: [], recordCount: 0, unlockCount: 3, unlockTexts: [] });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => assert.fail('沒有紀錄表可開就不該去讀'),
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /無法比對/);
});

test('多張紀錄表時，只鎖定 TEMSIS 相符的那一張', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄' },
      { recordIndex: 2, unlockIndex: 2, recordText: '救護紀錄' },
    ],
    recordCount: 3,
    unlockCount: 3,
    unlockTexts: [],
  });
  const sheetTemsis = ['T115070100001', 'T115070100002', 'T115070100003'];
  const outcome = await locateUnlockTarget({}, page, 'T115070100002', {
    readCodes: async (_context, _page, _texts, index) => ({
      dispatchNo: '1150701000123',
      temsis: sheetTemsis[index],
      kind: 'pdf',
    }),
  });
  assert.equal(outcome.status, '已定位');
  assert.match(outcome.detail, /第 2 張/);
  assert.match(outcome.detail, /第 2 個解鎖按鈕/);
});

test('多張紀錄表都對不上時回報需人工處理，絕不隨便挑一張', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100009', {
    readCodes: async () => ({ dispatchNo: '1150701000123', temsis: 'T115070100001', kind: 'pdf' }),
  });
  assert.equal(outcome.status, '需人工處理');
});

test('TEMSIS 相符但同一列找不到解鎖按鈕時，寧可人工處理也不猜按鈕', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: -1, recordText: '救護紀錄' },
      { recordIndex: 1, unlockIndex: -1, recordText: '救護紀錄' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => ({ dispatchNo: '1150701000123', temsis: 'T115070100001', kind: 'pdf' }),
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /同一列/);
});

test('groupByRow 把同一列的多個按鈕算成一筆案件', () => {
  const matches = [
    { index: 0, rowIndex: 5, text: '救護紀錄PDF', tag: 'img', visible: true },
    { index: 1, rowIndex: 5, text: '救護紀錄PDF(桃)', tag: 'img', visible: true },
    { index: 2, rowIndex: 6, text: '救護紀錄PDF', tag: 'img', visible: true },
  ];
  const groups = groupByRow(matches);
  assert.equal(groups.length, 2, '兩列＝兩筆案件');
  assert.equal(groups[0][0].index, 0, '每組第一個要是該列最前面的按鈕');
  assert.equal(groups[1][0].index, 2);
});

test('groupByRow 對不在表格內的元素各自獨立成一組', () => {
  const matches = [
    { index: 0, rowIndex: -1, text: '查詢', tag: 'img', visible: true },
    { index: 1, rowIndex: -1, text: '查詢', tag: 'img', visible: true },
  ];
  assert.equal(groupByRow(matches).length, 2);
});

test('normalizeText 去掉空白與標點並轉大寫', () => {
  assert.equal(normalizeText(' T E M S I S 編號：'), 'TEMSIS編號');
  assert.equal(normalizeText('派遣案號　：'), '派遣案號');
});

test('getRecentRange 回推兩個月且不會因大小月而算短', () => {
  const range = getRecentRange(2, new Date(2026, 6, 31)); // 2026-07-31
  assert.equal(range.start, '2026-05-31');
  assert.equal(range.end, '2026-07-31');

  // 5/31 往回兩個月＝3/31（存在），4/30 往回兩個月＝2/28（2 月沒有 30 號，夾到月底）
  assert.equal(getRecentRange(2, new Date(2026, 4, 31)).start, '2026-03-31');
  assert.equal(getRecentRange(2, new Date(2026, 3, 30)).start, '2026-02-28');
});

test('getRecentRange 跨年也要正確', () => {
  const range = getRecentRange(2, new Date(2026, 0, 15)); // 2026-01-15
  assert.equal(range.start, '2025-11-15');
  assert.equal(range.end, '2026-01-15');
});
