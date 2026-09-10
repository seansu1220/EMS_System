/**
 * 增減資料來源（Google 試算表）的解析測試。
 * 只測純函式，不連網。執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  describeSheet,
  buildCsvUrl,
  parseSheetDate,
  resolveAdjustColumns,
  countAdjustmentsBySquad,
  resolveAdjustTemsisColumn,
  resolveAdjustReasonColumn,
  collectAdjustRows,
} from './adjustSheet.mjs';

test('parseCsv 處理引號、逗號與跨行儲存格', () => {
  const csv = '日期,分隊,原因\n2026-06-01,桃園分隊,"備註,含逗號"\n2026-06-02,大林分隊,"換行\n測試"\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['日期', '分隊', '原因']);
  assert.equal(rows[1][2], '備註,含逗號', '引號內的逗號不可當成欄位分隔');
  assert.equal(rows[2][2], '換行\n測試', '引號內的換行不可當成換列');
});

test('parseCsv 處理逸出的雙引號並略過全空白列', () => {
  const rows = parseCsv('a,b\n"說""引號""",2\n,\n \n');
  assert.deepEqual(rows[1], ['說"引號"', '2']);
  assert.equal(rows.length, 2, '全空白的列要略過');
});

test('describeSheet 推測欄位型態且不輸出任何內容', () => {
  const rows = [
    ['案發日期', '出勤單位', '件數'],
    ['2026-06-01 08:30', '桃園分隊', '1'],
    ['2026-06-02 09:15', '大林分隊', '1'],
    ['2026-06-03 10:00', '桃園分隊', '1'],
  ];
  const info = describeSheet(rows);

  assert.equal(info.rowCount, 4);
  assert.equal(info.columnCount, 3);
  assert.deepEqual(info.columns[0].kinds, ['日期', '時間']);
  assert.deepEqual(info.columns[1].kinds, ['分隊名稱']);
  assert.deepEqual(info.columns[2].kinds, ['數字']);
  assert.equal(info.columns[1].distinct, 2);

  const serialized = JSON.stringify(info);
  assert.ok(!serialized.includes('桃園分隊'), '診斷資訊不可含任何儲存格內容');
  assert.ok(!serialized.includes('2026-06-01'), '診斷資訊不可含任何儲存格內容');
});

test('buildCsvUrl 未指定 gid 時不可帶該參數', () => {
  // 曾因預設 gid=0 而拿到 HTTP 400：第一個分頁的 gid 未必是 0。
  assert.equal(buildCsvUrl('ABC', null), 'https://docs.google.com/spreadsheets/d/ABC/export?format=csv');
  assert.equal(buildCsvUrl('ABC', ''), 'https://docs.google.com/spreadsheets/d/ABC/export?format=csv');
  assert.equal(buildCsvUrl('ABC', '123'), 'https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=123');
});

test('parseSheetDate 容錯各種日期寫法', () => {
  assert.equal(parseSheetDate('2026-06-01'), '2026-06-01');
  assert.equal(parseSheetDate('2026/6/1'), '2026-06-01');
  assert.equal(parseSheetDate('2026/6/1 上午 08:30'), '2026-06-01');
  assert.equal(parseSheetDate('2026年6月1日'), '2026-06-01');
  assert.equal(parseSheetDate('115/6/1'), '2026-06-01', '民國年要換算');
  assert.equal(parseSheetDate('沒有日期'), null);
  assert.equal(parseSheetDate('2026-13-01'), null, '不合理的月份不接受');
  assert.equal(parseSheetDate(''), null);
});

test('resolveAdjustColumns 以內容判定日期欄與分隊欄', () => {
  const rows = [
    ['編號', '案發時間', '單位', '備註'],
    ['A1', '2026-06-01 08:30', '桃園分隊', '重複派遣'],
    ['A2', '2026/6/2', '大林分隊', ''],
    ['A3', '115/6/3', '中路分隊', ''],
  ];
  assert.deepEqual(resolveAdjustColumns(rows), {
    dateColumn: 1, squadColumn: 2, temsisColumn: -1, reasonColumn: 3,
  });
});

test('countAdjustmentsBySquad 只計期間內的列', () => {
  const rows = [
    ['時間', '分隊'],
    ['2026-06-01', '桃園分隊'],
    ['2026-06-30', '桃園分隊'],
    ['2026-07-01', '桃園分隊'],
    ['2026-05-31', '大林分隊'],
    ['沒日期', '大林分隊'],
  ];
  const range = { label: '2026-06', start: '2026-06-01', end: '2026-06-30' };
  const result = countAdjustmentsBySquad(rows, { dateColumn: 0, squadColumn: 1 }, range);

  assert.equal(result.counts.get('桃園分隊'), 2, '起訖日皆須含在內');
  assert.equal(result.counts.has('大林分隊'), false);
  assert.equal(result.inRange, 2);
  assert.equal(result.outOfRange, 2);
  assert.equal(result.unparsable, 1);
});

test('describeSheet 的日期判定與實際判定一致（含民國年與年月日寫法）', () => {
  // 診斷若用比實際判定更嚴格的規則，會出現「說不像日期、卻被判成日期欄」的矛盾訊息。
  const rows = [
    ['時間', '分隊'],
    ['2026年6月1日', '桃園分隊'],
    ['115/6/2', '大林分隊'],
    ['2026/6/3 上午 08:30', '中路分隊'],
  ];
  const info = describeSheet(rows);
  assert.ok(info.columns[0].kinds.includes('日期'), '診斷要認得出這是日期欄');
  assert.equal(resolveAdjustColumns(rows).dateColumn, 0, '實際判定也要是同一欄');
});

test('resolveAdjustTemsisColumn 依內容認出 TEMSIS 欄，不看欄名', () => {
  const rows = [
    ['項次', '時間', '隨便取的欄名', '分隊'],
    ['1', '2026-08-01', '2026080110100318521101', '桃園分隊'],
    ['2', '2026-08-02', '2026080210100308285101', '大林分隊'],
    ['3', '2026-08-03', '2026080310100307580401', '中路分隊'],
  ];
  assert.equal(resolveAdjustTemsisColumn(rows), 2);
});

test('沒有任何一欄是長數字時回傳 -1，不亂猜欄位', () => {
  const rows = [
    ['時間', '分隊'],
    ['2026-08-01', '桃園分隊'],
    ['2026-08-02', '大林分隊'],
  ];
  assert.equal(resolveAdjustTemsisColumn(rows), -1);
});

test('resolveAdjustReasonColumn 依欄名找出扣除原因欄', () => {
  const rows = [['項次', '時間', '案號(TEMSIS ID)', '分隊', '扣除原因'], ['1', '2026-08-01', '', '桃園分隊', '系統異常']];
  assert.equal(resolveAdjustReasonColumn(rows), 4);
  assert.equal(resolveAdjustReasonColumn([['項次', '時間'], ['1', '2026-08-01']]), -1);
});

test('collectAdjustRows 只取期間內的列，並保留原始內容與列號', () => {
  const rows = [
    ['項次', '時間', '案號(TEMSIS ID)', '分隊', '扣除原因'],
    ['1', '2026-08-05', '2026080510100311365603', '桃園分隊', '系統異常，到院才恢復'],
    ['2', '2026-07-31', '2026073110100315591101', '大林分隊', '期間外'],
    ['3', '2026-08-22', '', '山腳分隊', '沒填 TEMSIS 也要收，對帳時才判得出來'],
    ['4', '看不懂的日期', '2026080110100318521101', '中路分隊', '日期讀不出來'],
    ['5', '2026-08-10', '2026081010100305322301', '', '沒填分隊'],
  ];
  const columns = { dateColumn: 1, squadColumn: 3, temsisColumn: 2, reasonColumn: 4 };
  const result = collectAdjustRows(rows, columns, { start: '2026-08-01', end: '2026-08-31' });

  assert.equal(result.outOfRange, 1);
  assert.equal(result.unparsable, 2, '日期讀不出來與分隊空白都算無法判讀');
  assert.deepEqual(
    result.inRange.map((item) => [item.squad, item.temsis, item.lineNumber]),
    [
      ['桃園分隊', '2026080510100311365603', 2],
      ['山腳分隊', '', 4],
    ],
  );
  assert.equal(result.inRange[0].reason, '系統異常，到院才恢復');
  assert.equal(result.inRange[0].isoDate, '2026-08-05');
});

test('沒有 TEMSIS 欄與原因欄時（欄索引 -1）仍取得出列，只是那兩欄是空字串', () => {
  const rows = [['時間', '分隊'], ['2026-08-05', '桃園分隊']];
  const result = collectAdjustRows(rows, { dateColumn: 0, squadColumn: 1, temsisColumn: -1, reasonColumn: -1 },
    { start: '2026-08-01', end: '2026-08-31' });
  assert.equal(result.inRange.length, 1);
  assert.equal(result.inRange[0].temsis, '');
  assert.equal(result.inRange[0].reason, '');
});

test('resolveAdjustColumns 一併回傳 TEMSIS 欄與原因欄', () => {
  const rows = [
    ['項次', '時間', '案號(TEMSIS ID)', '分隊', '扣除原因'],
    ['1', '2026-08-01', '2026080110100318521101', '桃園分隊', '系統異常'],
    ['2', '2026-08-02', '2026080210100308285101', '大林分隊', '系統異常'],
    ['3', '2026-08-03', '2026080310100307580401', '中路分隊', '系統異常'],
  ];
  assert.deepEqual(resolveAdjustColumns(rows), {
    dateColumn: 1, squadColumn: 3, temsisColumn: 2, reasonColumn: 4,
  });
});
