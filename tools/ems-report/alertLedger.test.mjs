/**
 * 未預警逐案清冊的單元測試。
 *
 * 重點放在「差集算得對不對」與「已提報的註記有沒有標上」——
 * 這兩件事錯了會直接讓分隊拿到錯的案件清單。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnalertedCases,
  summarizeUnalerted,
  buildUnalertedWorkbook,
} from './alertLedger.mjs';

const HEADERS = ['出勤單位', '受理時間', 'TEMSISID'];

/** 組出一份假的匯出檔來源。 */
function sourceOf(rows) {
  return {
    headers: HEADERS,
    squadColumn: '出勤單位',
    rows: rows.map(([squad, caseDate, temsis]) => ({
      出勤單位: squad,
      受理時間: caseDate,
      TEMSISID: temsis,
    })),
  };
}

const monthRange = { start: '2026-08-01', end: '2026-08-31', label: '2026-08' };

test('未預警案件＝總案件減掉預警案件', () => {
  const total = sourceOf([
    ['山腳分隊', '2026/08/01 08:00:00', 'A1'],
    ['山腳分隊', '2026/08/02 09:00:00', 'A2'],
    ['巴陵分隊', '2026/08/03 10:00:00', 'B1'],
  ]);
  const alert = sourceOf([['山腳分隊', '2026/08/01 08:00:00', 'A1']]);

  const cases = buildUnalertedCases(total, alert);
  assert.deepEqual(
    cases.map((item) => item.temsis),
    ['A2', 'B1'], // 依分隊名稱排序（zh-Hant：山腳在巴陵前），同隊再依案件日期
  );
});

test('增減試算表上有的案件標成已提報，其餘為否', () => {
  const total = sourceOf([
    ['山腳分隊', '2026/08/02 09:00:00', 'A2'],
    ['山腳分隊', '2026/08/05 09:00:00', 'A3'],
  ]);
  const alert = sourceOf([]);

  const cases = buildUnalertedCases(total, alert, new Set(['A3']));
  assert.deepEqual(
    cases.map((item) => [item.temsis, item.reported]),
    [['A2', false], ['A3', true]],
  );
});

test('已提報的案件仍要列出來，不會被當成扣掉就消失', () => {
  const total = sourceOf([['山腳分隊', '2026/08/02 09:00:00', 'A2']]);
  const cases = buildUnalertedCases(total, sourceOf([]), new Set(['A2']));
  assert.equal(cases.length, 1);
  assert.equal(cases[0].reported, true);
});

test('同一件案子在兩份匯出檔都在時不列入（TEMSIS 前後空白不影響比對）', () => {
  const total = sourceOf([['山腳分隊', '2026/08/01 08:00:00', ' A1 ']]);
  const alert = sourceOf([['山腳分隊', '2026/08/01 08:00:00', 'A1']]);
  assert.deepEqual(buildUnalertedCases(total, alert), []);
});

test('分隊彙總依件數由多到少，並算出其中已提報幾件', () => {
  const cases = [
    { squad: '山腳分隊', caseDate: '', temsis: 'A1', reported: false },
    { squad: '山腳分隊', caseDate: '', temsis: 'A2', reported: true },
    { squad: '巴陵分隊', caseDate: '', temsis: 'B1', reported: false },
  ];
  assert.deepEqual(summarizeUnalerted(cases), [
    { squad: '山腳分隊', count: 2, reported: 1 },
    { squad: '巴陵分隊', count: 1, reported: 0 },
  ]);
});

test('找不到 TEMSIS 欄時直接報錯，不默默算出整份總案件', () => {
  const broken = { headers: ['出勤單位'], squadColumn: '出勤單位', rows: [{ 出勤單位: '山腳分隊' }] };
  assert.throws(() => buildUnalertedCases(broken, broken), /找不到 TEMSIS 欄/);
});

test('活頁簿有兩個分頁，合計列放在各分隊件數的最前面', () => {
  const cases = [
    { squad: '山腳分隊', caseDate: '2026/08/02 09:00:00', temsis: 'A2', reported: true },
    { squad: '巴陵分隊', caseDate: '2026/08/03 10:00:00', temsis: 'B1', reported: false },
  ];
  const workbook = buildUnalertedWorkbook(cases, monthRange);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['各分隊件數', '逐案清單'],
  );

  const summary = workbook.getWorksheet('各分隊件數');
  // 第 1 列是大標、第 2 列是欄名，第 3 列才是合計。
  assert.deepEqual(summary.getRow(3).values.slice(1), ['合計', 2, 1]);

  // 逐案清單照傳進來的順序寫（排序在 buildUnalertedCases 就做完了）。
  const detail = workbook.getWorksheet('逐案清單');
  assert.deepEqual(detail.getRow(3).values.slice(1), ['山腳分隊', '2026/08/02 09:00:00', 'A2', '是']);
  assert.deepEqual(detail.getRow(4).values.slice(1), ['巴陵分隊', '2026/08/03 10:00:00', 'B1', '否']);
});

test('案件日期讀不到時寫「(讀不到)」，不留空格讓人以為漏掉', () => {
  const cases = [{ squad: '山腳分隊', caseDate: '', temsis: 'A2', reported: false }];
  const detail = buildUnalertedWorkbook(cases, monthRange).getWorksheet('逐案清單');
  assert.equal(detail.getRow(3).getCell(2).value, '(讀不到)');
});
