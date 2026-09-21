/**
 * 逐案判定表的測試（在記憶體中組資料列與活頁簿，不寫檔、不動使用者的報表）。
 *
 * 釘住的是這份表存在的理由：分隊來問「我這件算在哪」時，
 * 三種歸屬必須在表上分得出來——尤其是「沒有 12 導程所以根本沒得查」
 * 不可以跟「查了但判成到院後」混為一談。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerRows, buildLedgerWorkbook, LEDGER_COLUMNS } from './ekgLedger.mjs';
import { VERDICT } from './ekgVerify.mjs';

const MONTH = { start: '2026-07-01', end: '2026-07-31', label: '2026-07' };

/** 用欄名取值，不要寫死序號——中間插一欄就會全部錯位。 */
const at = (row, columnName) => row[LEDGER_COLUMNS.indexOf(columnName)];

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
  assert.match(String(at(沒得查, '依據')), /沒有 12 導程/);

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
  assert.match(String(at(未查核, '依據')), /沒有查核到/);
});

test('活頁簿：大標與欄名都在，TEMSIS 完整顯示', () => {
  const rows = buildLedgerRows(source([只勾處置]), source([]), []);
  const sheet = buildLedgerWorkbook(rows, MONTH).getWorksheet('逐案判定');
  assert.equal(sheet.getCell(1, 1).value, `${MONTH.label}　心電圖逐案判定表`);
  assert.equal(sheet.getCell(2, 1).value, '分隊');
  assert.equal(sheet.getCell(2, 9).value, '計入分子');
  assert.equal(sheet.getCell(3, 3).value, 'T-2501');
});

test('有申訴時多一個分頁，而且不可以把發生地點寫進去', () => {
  const rows = buildLedgerRows(source([只勾處置]), source([]), []);
  const workbook = buildLedgerWorkbook(rows, MONTH, [{
    appeal: {
      squad: '平鎮分隊', caseDate: '2026/7/20 20:20', temsis: 'T-2501',
      place: '平鎮區延平路三段8號', epochMs: 0, lineNumber: 3,
    },
    outcome: '補進分子',
    matchedBy: 'TEMSIS',
    reason: '原本沒有 12 導程可查核，依申訴改列為到院前傳出',
  }]);

  const sheet = workbook.getWorksheet('申訴處理');
  assert.ok(sheet, '應該要有申訴處理分頁');
  assert.equal(sheet.getCell(2, 4).value, '處理結果');
  assert.equal(sheet.getCell(3, 1).value, '平鎮分隊');
  assert.equal(sheet.getCell(3, 4).value, '補進分子');

  // 發生地點是個資，只用來比對，一個儲存格都不可以寫出來。
  const everyCell = [];
  sheet.eachRow((row) => row.eachCell((item) => everyCell.push(String(item.value ?? ''))));
  assert.ok(!everyCell.some((value) => value.includes('延平路')), '發生地點不可以出現在輸出檔裡');
});

test('沒有申訴時不要生出一個空的申訴分頁', () => {
  const rows = buildLedgerRows(source([只勾處置]), source([]), []);
  assert.equal(buildLedgerWorkbook(rows, MONTH, []).getWorksheet('申訴處理'), undefined);
});

test('被排除的 OHCA 案件要留在表上，而且排在最前面', () => {
  // ⚠ 它們已經不在分母裡，但一定要看得到——分隊來對數字時，
  //   少掉的那幾件如果不在表上，就變成查不出原因的差異。
  const rows = buildLedgerRows(
    source([只勾處置]),
    source([兩者都有_過]),
    OUTCOMES,
    [{
      temsis: 'T-9901', squad: '三民分隊', caseDate: '2026/07/12 15:38:39', from: '有12導程',
    }],
  );

  assert.equal(rows.length, 3, '2 件在分母內 ＋ 1 件已排除');
  assert.equal(rows[0][2], 'T-9901', '排除的要在第一列');
  assert.equal(rows[0][0], '三民分隊');
  assert.match(String(rows[0][7]), /排除.*CPR/, '判定欄要講明是為什麼被排除');
  assert.equal(rows[0][8], '否', '排除的一律不計入分子');
  assert.match(String(at(rows[0], '依據')), /OHCA/, '依據要說得出是 OHCA');
});

test('排除的案件要標出它原本出現在哪一份查詢結果裡', () => {
  const rows = buildLedgerRows(
    source([]),
    source([]),
    [],
    [
      { temsis: 'T-A', squad: '三民分隊', caseDate: '2026/07/12', from: '有12導程' },
      { temsis: 'T-B', squad: '平鎮分隊', caseDate: '2026/07/19', from: '有勾EKG檢查、有12導程' },
    ],
  );
  const [onlyTwelve, both] = rows;
  assert.deepEqual([onlyTwelve[3], onlyTwelve[4]], ['否', '是'], '只在 12 導程那份');
  assert.deepEqual([both[3], both[4]], ['是', '是'], '兩份都有');
});

test('沒有排除的案件時，表上一列都不會多出來', () => {
  const rows = buildLedgerRows(source([只勾處置]), source([]), [], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], 'T-2501');
});

test('到院後但備註有補述的，判定寫到院後、計入分子寫是，而且看得到理由', () => {
  // ⚠ 這張表最怕的就是「判定寫到院後、計入分子寫是」卻說不出為什麼——
  //   分隊來對數字時會覺得這張表自相矛盾，而它存在的理由正是「查得出每一件算在哪」。
  const rows = buildLedgerRows(source([]), source([兩者都有_到院後]), [{
    temsis: 'T-1702',
    squad: '平鎮分隊',
    verdict: VERDICT.after,
    reason: '上傳時間晚於到院時間（上傳時間取自「上傳」清單…）',
    arrival: '2026/07/19 12:41:53',
    upload: '2026/07/19 12:55:00',
    source: '案件內部的「上傳」',
    caseDate: '2026/07/19 12:13:17',
    remark: { text: '現場無訊號，回隊才傳成功', from: '12導程心電圖／CHFD_1.json' },
    mediaReviews: [],
  }]);

  const 補述 = rowOf(rows, 'T-1702');
  assert.equal(at(補述, '判定'), VERDICT.after, '判定要照實寫，不可以改成到院前');
  assert.equal(at(補述, '計入分子'), '是');
  assert.equal(at(補述, '補述理由'), '現場無訊號，回隊才傳成功');
});
