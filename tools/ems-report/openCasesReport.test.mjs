/**
 * 未結案案件統整報表的內容測試（在記憶體裡組活頁簿，不寫檔）。
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CASE_COLUMNS,
  buildCaseRows,
  buildFailureRows,
  buildSummaryRows,
  buildOpenCaseWorkbook,
} from './openCasesReport.mjs';

const RANGE = { label: '2026-09-01至2026-09-30', start: '2026-09-01', end: '2026-09-30' };

function summary(overrides) {
  return {
    dispatchNo: 'D1',
    caseDate: '2026/09/02',
    squads: ['平鎮分隊'],
    recordCount: 2,
    statusText: '已結案*1+已填寫*1',
    hasClosed: true,
    openTemsis: ['T1'],
    records: [],
    notes: [],
    error: null,
    ...overrides,
  };
}

const RESULT = {
  recordCount: 4,
  skipped: 0,
  aborted: false,
  lookups: [
    { temsis: 'T1', squad: '平鎮分隊', caseDate: '', dispatchNo: 'D1', error: null },
    { temsis: 'T2', squad: '龍潭分隊', caseDate: '', dispatchNo: 'D2', error: null },
    { temsis: 'T3', squad: '龍潭分隊', caseDate: '', dispatchNo: 'D3', error: null },
    { temsis: 'T4', squad: '大園分隊', caseDate: '2026/09/09', dispatchNo: null, error: '讀不到案號' },
  ],
  summaries: [
    summary({
      dispatchNo: 'D2',
      caseDate: '2026/09/05',
      hasClosed: false,
      statusText: '已填寫*1+未填寫*1',
      openTemsis: ['T2', 'T5'],
      records: [{ itemNo: '1', date: '09-05', vehicle: '龍潭91', squad: '龍潭分隊', status: '已填寫' }],
    }),
    summary({ dispatchNo: 'D1', caseDate: '2026/09/02' }),
    summary({ dispatchNo: 'D3', caseDate: '2026/09/07', hasClosed: null, recordCount: 0, statusText: '', error: '進不去' }),
  ],
};

test('buildCaseRows 依日期排序，沒有已結案寫「無」，失敗寫「讀取失敗」', () => {
  const rows = buildCaseRows(RESULT.summaries);
  const column = (name) => rows.map((row) => row[CASE_COLUMNS.indexOf(name)]);
  assert.deepEqual(column('派遣案號'), ['D1', 'D2', 'D3']);
  assert.deepEqual(column('有已結案'), ['有', '無', '讀取失敗']);
  assert.equal(column('未結案的紀錄表（TEMSIS）')[1], 'T2\nT5');
  assert.equal(column('備註')[2], '進不去');
  assert.equal(column('救護表狀態統整')[2], '', '失敗的不寫統整');
});

test('buildFailureRows 兩個階段的失敗都列出來', () => {
  const rows = buildFailureRows(RESULT);
  assert.deepEqual(rows.map((row) => row[0]), ['讀指派案號', '進案件內部']);
  assert.equal(rows[0][1], 'T4');
  assert.equal(rows[1][1], 'D3');
});

test('buildSummaryRows 報出「連一張已結案都沒有」的件數，失敗的不算進去', () => {
  const rows = new Map(buildSummaryRows(RESULT, RANGE));
  assert.equal(rows.get('連一張已結案都沒有的案件'), '1 件');
  assert.equal(rows.get('有已結案的案件'), '1 件');
  assert.match(rows.get('合併成案件'), /3 件.*讀取失敗 1 件/);
  assert.match(rows.get('讀到指派案號'), /3 張（讀不到 1 張）/);
  assert.equal(rows.has('⚠ 中途停止'), false);
  const partial = new Map(buildSummaryRows({ ...RESULT, aborted: true, skipped: 5 }, RANGE));
  assert.ok(partial.has('⚠ 中途停止'));
  assert.ok(partial.has('⚠ 只跑了一部分'));
});

test('buildOpenCaseWorkbook 四個分頁，沒有已結案的那一列塗底色', () => {
  const workbook = buildOpenCaseWorkbook(RESULT, RANGE);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['摘要', '案件統整', '各張紀錄表', '讀取失敗']);
  const caseSheet = workbook.getWorksheet('案件統整');
  // 第 3 列起是資料；依日期排序後 D2（沒有已結案）在第 4 列。
  assert.equal(caseSheet.getRow(4).getCell(2).value, 'D2');
  assert.equal(caseSheet.getRow(4).getCell(1).fill?.fgColor?.argb, 'FFFFF2CC');
  assert.notEqual(caseSheet.getRow(3).getCell(1).fill?.fgColor?.argb, 'FFFFF2CC');
  assert.equal(workbook.getWorksheet('各張紀錄表').getRow(3).getCell(4).value, '龍潭91');
});

test('buildOpenCaseWorkbook 沒有失敗就不建「讀取失敗」分頁', () => {
  const clean = { ...RESULT, lookups: RESULT.lookups.slice(0, 2), summaries: RESULT.summaries.slice(0, 2) };
  const names = buildOpenCaseWorkbook(clean, RANGE).worksheets.map((sheet) => sheet.name);
  assert.equal(names.includes('讀取失敗'), false);
});
