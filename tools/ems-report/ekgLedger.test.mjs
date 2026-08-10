/**
 * 逐案判定表的測試（在記憶體中組資料列與活頁簿，不寫檔、不動使用者的報表）。
 *
 * 釘住的是這份表存在的理由：分隊來問「我這件算在哪」時，
 * 三種歸屬必須在表上分得出來——尤其是「沒有 12 導程所以根本沒得查」
 * 不可以跟「查了但判成到院後」混為一談。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerRows, buildLedgerWorkbook } from './ekgLedger.mjs';
import { VERDICT } from './ekgVerify.mjs';

const MONTH = { start: '2026-07-01', end: '2026-07-31', label: '2026-07' };

const HEADERS = ['出勤單位', '受理時間', 'TEMSIS ID', '送達醫院時間'];
const source = (rows) => ({
  headers: HEADERS,
  rows,
  temsisColumn: 'TEMSIS ID',
  squadColumn: '出勤單位',
  arrivalColumn: '送達醫院時間',
});

/** 三種案子各一：兩者都有且過、兩者都有但到院後、只勾EKG檢查沒12導程。 */
const 兩者都有_過 = {
  出勤單位: '平鎮分隊', 受理時間: '2026/07/06 12:28:37', 'TEMSIS ID': 'T-3701', 送達醫院時間: '2026/07/06 12:51:12',
};
const 兩者都有_到院後 = {
  出勤單位: '平鎮分隊', 受理時間: '2026/07/19 12:13:17', 'TEMSIS ID': 'T-1702', 送達醫院時間: '2026/07/19 12:41:53',
};
const 只勾處置 = {
  出勤單位: '平鎮分隊', 受理時間: '2026/07/02 22:14:25', 'TEMSIS ID': 'T-2501', 送達醫院時間: '2026/07/02 22:40:00',
};

const OUTCOMES = [
  {
    temsis: 'T-3701', squad: '平鎮分隊', verdict: VERDICT.before, reason: '上傳早於到院',
    arrival: '2026/07/06 12:51:12', upload: '2026-07-06 12:40:45', source: '上傳',
  },
  {
    temsis: 'T-1702', squad: '平鎮分隊', verdict: VERDICT.after, reason: '上傳晚於到院',
    arrival: '2026/07/19 12:41:53', upload: '2026-07-19 12:50:53', source: '傳輸紀錄',
  },
];

/** 依 TEMSIS 取出那一列，測試才不必依賴排序結果。 */
function rowOf(rows, temsis) {
  const found = rows.find((row) => row[2] === temsis);
  assert.ok(found, `表上找不到 ${temsis}`);
  return found;
}

test('分母是聯集：只在其中一份匯出檔裡的案件也要在表上', () => {
  const rows = buildLedgerRows(
    source([兩者都有_過, 兩者都有_到院後, 只勾處置]),
    source([兩者都有_過, 兩者都有_到院後]),
    OUTCOMES,
  );
  assert.equal(rows.length, 3, '3 件案子（聯集去重後）應該都在表上');
});

test('「沒有12導程所以沒得查」不可以跟「查了判到院後」混為一談', () => {
  const rows = buildLedgerRows(
    source([兩者都有_過, 兩者都有_到院後, 只勾處置]),
    source([兩者都有_過, 兩者都有_到院後]),
    OUTCOMES,
  );

  const 沒得查 = rowOf(rows, 'T-2501');
  assert.equal(沒得查[4], '否', '有12導程欄應為否');
  assert.equal(沒得查[7], '沒有12導程，未查核');
  assert.equal(沒得查[8], '否', '不計入分子');
  assert.match(String(沒得查[9]), /沒有 12 導程/);

  const 到院後 = rowOf(rows, 'T-1702');
  assert.equal(到院後[4], '是', '這件是有12導程的');
  assert.equal(到院後[7], VERDICT.after);
  assert.equal(到院後[8], '否');
});

test('只有判定為到院前的才標「計入分子」，且帶得出上傳時間', () => {
  const rows = buildLedgerRows(
    source([兩者都有_過, 兩者都有_到院後, 只勾處置]),
    source([兩者都有_過, 兩者都有_到院後]),
    OUTCOMES,
  );
  const 過了 = rowOf(rows, 'T-3701');
  assert.equal(過了[7], VERDICT.before);
  assert.equal(過了[8], '是');
  assert.equal(過了[6], '2026-07-06 12:40:45');
  assert.equal(rows.filter((row) => row[8] === '是').length, 1);
});

test('沒進分子的排前面（來對數字的人要看的就是這些）', () => {
  const rows = buildLedgerRows(
    source([兩者都有_過, 兩者都有_到院後, 只勾處置]),
    source([兩者都有_過, 兩者都有_到院後]),
    OUTCOMES,
  );
  assert.deepEqual(rows.map((row) => row[8]), ['否', '否', '是']);
});

test('沒勾EKG檢查、只有12導程的案件，勾EKG檢查欄要是否', () => {
  const rows = buildLedgerRows(source([]), source([兩者都有_過]), OUTCOMES);
  const 只有12導程 = rowOf(rows, 'T-3701');
  assert.equal(只有12導程[3], '否');
  assert.equal(只有12導程[4], '是');
});

test('有12導程卻沒查核到的案件，要說「沒查核到」而不是留白', () => {
  const rows = buildLedgerRows(source([]), source([兩者都有_過]), []);
  const 未查核 = rowOf(rows, 'T-3701');
  assert.equal(未查核[7], '未查核');
  assert.equal(未查核[8], '否');
  assert.match(String(未查核[9]), /沒有查核到/);
});

test('活頁簿：大標與欄名都在，TEMSIS 完整顯示', () => {
  const rows = buildLedgerRows(source([只勾處置]), source([]), []);
  const sheet = buildLedgerWorkbook(rows, MONTH).getWorksheet('逐案判定');
  assert.equal(sheet.getCell(1, 1).value, `${MONTH.label}　心電圖逐案判定表`);
  assert.equal(sheet.getCell(2, 1).value, '分隊');
  assert.equal(sheet.getCell(2, 9).value, '計入分子');
  assert.equal(sheet.getCell(3, 3).value, 'T-2501');
});
