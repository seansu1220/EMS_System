/**
 * 解鎖修改紀錄的測試（純函式與活頁簿組裝，不讀本機檔案、不連雲端）。
 *
 * 釘住的是使用者要的三樣東西都在、而且不會漏件或重複：
 *   1. 期間依解鎖時間（本機時區）判斷，起訖日都含；結案前又解鎖的舊版不列
 *   2. 未結案、已結案分得對；已結案的每一件在修改內容分頁至少一列
 *   3. 原內容 → 修改後：判斷得出欄位時一欄一列，判斷不出時整段照列
 *   4. 申請事由：線上工單從雲端補讀，手動解鎖、讀不到時寫明
 *   5. 編號與原表資料夾對得起來：總表第一欄點下去開的，就是複製原表的那個資料夾
 *
 * 執行：npm run tool:ems:test
 */
// 期間判斷用本機時區：固定成台灣時間，換到別的時區的電腦跑也一樣。
process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChangeRows,
  buildOpenRows,
  buildReasonRows,
  buildRevisionReportWorkbook,
  caseFilesToCopy,
  caseFolderPath,
  caseNumber,
  classifyEntries,
  selectEntriesInRange,
  toChangeRows,
} from './revisionMonthly.mjs';

/** 造一筆追蹤項目（只填報表用得到的欄位）。 */
function entry(overrides = {}) {
  return {
    temsis: '2026101210100310380001',
    version: 1,
    remark: '救護紀錄表內容-v1',
    backupFile: 'before.pdf',
    unlockedAt: '2026-10-12T02:00:00.000Z',
    requestId: 'req-1',
    caseDate: '2026-10-12',
    vehicle: '大湳91',
    squad: '大湳分隊',
    state: 'compared',
    lastCheckedAt: '2026-10-13T02:00:00.000Z',
    lastStatus: '已結案',
    comparedAt: '2026-10-13T02:00:00.000Z',
    closedFile: 'after.pdf',
    reportFile: 'report.txt',
    changeCount: 1,
    cloudItems: [],
    cloudSynced: true,
    failCount: 0,
    lastError: null,
    ...overrides,
  };
}

const OCTOBER = { start: '2026-10-01', end: '2026-10-31' };

test('期間依解鎖時間（台灣時間）判斷，起訖日都含', () => {
  const entries = [
    entry({ temsis: 'A', unlockedAt: '2026-09-30T16:30:00.000Z' }), // 台灣 10/1 00:30 → 算
    entry({ temsis: 'B', unlockedAt: '2026-10-31T15:59:00.000Z' }), // 台灣 10/31 23:59 → 算
    entry({ temsis: 'C', unlockedAt: '2026-10-31T16:00:00.000Z' }), // 台灣 11/1 00:00 → 不算
    entry({ temsis: 'D', unlockedAt: '2026-09-30T15:59:00.000Z' }), // 台灣 9/30 23:59 → 不算
  ];
  assert.deepEqual(selectEntriesInRange(entries, OCTOBER).map((item) => item.temsis), ['A', 'B']);
});

test('結案前又解鎖一次的舊版不列，免得同一件出現兩次', () => {
  const entries = [entry({ version: 1, state: 'superseded' }), entry({ version: 2, state: 'waiting' })];
  assert.deepEqual(selectEntriesInRange(entries, OCTOBER).map((item) => item.version), [2]);
});

test('等結案中算未結案；比對完成算已結案', () => {
  const { open, closed } = classifyEntries([
    entry({ temsis: 'A', state: 'waiting' }),
    entry({ temsis: 'B', state: 'compared' }),
    entry({ temsis: 'C', state: 'gaveUp' }),
  ]);
  assert.deepEqual(open.map((item) => item.temsis), ['A', 'C']);
  assert.deepEqual(closed.map((item) => item.temsis), ['B']);
});

test('判斷得出欄位時一個欄位一列，原內容與修改後都是完整內容（含姓名）', () => {
  const rows = toChangeRows({
    kind: 'value',
    before: ['王小明', 'A123456789'],
    after: ['王曉明', 'A123456780'],
    fields: ['傷病患姓名', '身分證字號'],
    fieldSource: 'inline',
    segments: [
      { label: '傷病患姓名', before: '王小明', after: '王曉明' },
      { label: '身分證字號', before: 'A123456789', after: 'A123456780' },
    ],
    option: null,
  }, 2000);
  assert.deepEqual(rows, [
    { field: '傷病患姓名', before: '王小明', after: '王曉明' },
    { field: '身分證字號', before: 'A123456789', after: 'A123456780' },
  ]);
});

test('判斷不出欄位時整段照列，欄位寫明', () => {
  const [row] = toChangeRows({
    kind: 'value', before: ['舊的'], after: ['新的'], fields: [], fieldSource: 'unknown', segments: [], option: null,
  }, 2000);
  assert.deepEqual(row, { field: '未能判斷欄位', before: '舊的', after: '新的' });
});

test('勾選框寫出是哪一項；空白寫「（空白）」', () => {
  const [row] = toChangeRows({
    kind: 'checkbox', before: ['□'], after: [], fields: [], fieldSource: 'unknown', segments: [], option: '意識不清',
  }, 2000);
  assert.deepEqual(row, { field: '勾選「意識不清」', before: '□', after: '（空白）' });
});

test('太長的內容會截斷', () => {
  const [row] = toChangeRows({
    kind: 'value', before: ['一'.repeat(50)], after: ['二'], fields: ['備註'], fieldSource: 'nearby', segments: [], option: null,
  }, 10);
  assert.equal(row.field, '備註（附近）');
  assert.equal(row.before, `${'一'.repeat(10)}…（後面省略）`);
});

test('每一件已結案在修改內容分頁至少一列：沒改動、讀不到檔案都寫明', () => {
  const rows = buildChangeRows([
    { entry: entry({ temsis: 'A' }), rows: [{ field: '血壓', before: '120/80', after: '130/85' }], error: null },
    { entry: entry({ temsis: 'B' }), rows: [], error: null },
    { entry: entry({ temsis: 'C' }), rows: null, error: '找不到 after.pdf' },
  ]);
  assert.deepEqual(rows.map((row) => row.slice(0, 2)), [['01', 'A'], ['02', 'B'], ['03', 'C']]);
  assert.deepEqual(rows[0].slice(4), [1, '血壓', '120/80', '130/85']);
  assert.equal(rows[1][5], '（解鎖後沒有改動任何內容）');
  assert.equal(rows[2][5], '（讀不到本機的紀錄表檔案，無法列出）');
});

test('申請事由：線上工單從雲端補讀；手動解鎖、沒連上、讀不到都寫明', () => {
  const details = new Map([['req-1', { reason: '補登生命徵象', requestedByName: '大湳分隊' }]]);
  const closed = [
    { entry: entry({ requestId: 'req-1' }), rows: [], error: null },
    { entry: entry({ requestId: null }), rows: [], error: null },
    { entry: entry({ requestId: 'req-gone' }), rows: [], error: null },
  ];
  const reasons = buildReasonRows(closed, details).map((row) => row[6]);
  assert.deepEqual(reasons, ['補登生命徵象', '（本機手動解鎖，沒有線上申請事由）', '（雲端讀不到這張工單）']);
  assert.equal(buildOpenRows([entry({ state: 'waiting' })], null)[0][9], '（沒連上雲端，讀不到事由）');
});

test('活頁簿有摘要、未結案、已結案-申請事由、已結案-修改內容四個分頁', () => {
  const workbook = buildRevisionReportWorkbook(OCTOBER, {
    open: [entry({ state: 'waiting' })],
    closed: [{ entry: entry(), rows: [{ field: '血壓', before: '120/80', after: '130/85' }], error: null }],
  }, null);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['摘要', '未結案', '已結案-申請事由', '已結案-修改內容']);
});

test('編號補零到至少 2 位，件數破百補到 3 位；資料夾名稱是「編號_TEMSIS」', () => {
  assert.equal(caseNumber(0, 5), '01');
  assert.equal(caseNumber(9, 120), '010');
  assert.equal(caseFolderPath('已結案', '03', '2026-1012 10100'), '已結案/03_2026101210100');
});

test('要複製的原表：未結案只有解鎖前；已結案再加結案後與差異說明，沒有的檔不列', () => {
  const closedEntry = entry({ backupFile: 'x/before.pdf', closedFile: 'x/after.pdf', reportFile: null });
  assert.deepEqual(caseFilesToCopy(entry({ state: 'waiting', backupFile: 'x/before.pdf' }), false), [
    { source: 'x/before.pdf', name: '解鎖前.pdf' },
  ]);
  assert.deepEqual(caseFilesToCopy(closedEntry, true), [
    { source: 'x/before.pdf', name: '解鎖前.pdf' },
    { source: 'x/after.pdf', name: '結案後.pdf' },
  ]);
});

test('總表各分頁的編號是超連結，指向同一件的原表資料夾', () => {
  const workbook = buildRevisionReportWorkbook(OCTOBER, {
    open: [entry({ state: 'waiting', temsis: 'OPEN1' })],
    closed: [
      { entry: entry({ temsis: 'DONE1' }), rows: [{ field: '血壓', before: '120/80', after: '130/85' }], error: null },
      { entry: entry({ temsis: 'DONE2' }), rows: [], error: null },
    ],
  }, null);
  const linkAt = (sheetName, rowNumber) => workbook.getWorksheet(sheetName).getRow(rowNumber).getCell(1).value;
  assert.deepEqual(linkAt('未結案', 3), { text: '01', hyperlink: '未結案/01_OPEN1' });
  assert.deepEqual(linkAt('已結案-申請事由', 4), { text: '02', hyperlink: '已結案/02_DONE2' });
  assert.deepEqual(linkAt('已結案-修改內容', 3), { text: '01', hyperlink: '已結案/01_DONE1' });
});
