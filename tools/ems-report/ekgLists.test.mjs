/**
 * 兩份附帶清單的版面測試（在記憶體中組活頁簿，不寫檔、不動使用者的報表）。
 *
 * 釘住的是使用者 2026-08-05 交代的三件事：
 *   1. 大標就叫「有處置未勾選清冊」，不要寫成一長串條件說明
 *   2. 這份清冊的 TEMSIS 完整顯示（要拿去跟分隊逐案核對）
 *   3. 標題那兩列都置中，而且不能有文字被遮住
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEkgOnlyWorkbook,
  buildMissingProcedureWorkbook,
  buildPendingWorkbook,
} from './ekgLists.mjs';
import { displayWidth } from './sheetLayout.mjs';

const MONTH = { start: '2026-07-01', end: '2026-07-31', label: '2026-07' };

/** 匯出檔那種「欄名 → 值」的資料列。 */
const COLUMNS = { headers: ['出勤單位', '受理時間', 'TEMSIS ID'], squadColumn: '出勤單位', temsisColumn: 'TEMSIS ID' };
const ROWS = [
  { 出勤單位: '蘆竹分隊', 受理時間: '2026/07/01 09:27:02', 'TEMSIS ID': '2026070110100310380201' },
  { 出勤單位: '蘆竹分隊', 受理時間: '2026/07/03 14:02:11', 'TEMSIS ID': '2026070310100310380202' },
  { 出勤單位: '山峰分隊', 受理時間: '2026/07/05 08:15:40', 'TEMSIS ID': '2026070510100310380303' },
];

/** 建好清冊，回傳兩個分頁供各測試取用。 */
function buildLists() {
  const { workbook, squadCount } = buildMissingProcedureWorkbook(ROWS, COLUMNS, MONTH);
  return {
    squadCount,
    summary: workbook.getWorksheet('各分隊件數'),
    detail: workbook.getWorksheet('逐案清單'),
  };
}

test('大標就是「有處置未勾選清冊」，兩個分頁都一樣', () => {
  const { summary, detail } = buildLists();
  const expected = `${MONTH.label}　有處置未勾選清冊`;
  assert.equal(summary.getCell(1, 1).value, expected);
  assert.equal(detail.getCell(1, 1).value, expected);
  // 舊的那串落落長標題不可以再出現。
  assert.doesNotMatch(String(detail.getCell(1, 1).value), /12\s*導程|EKG/);
});

test('標題與欄名那兩列都置中', () => {
  const { summary, detail } = buildLists();
  for (const sheet of [summary, detail]) {
    for (const rowNumber of [1, 2]) {
      const row = sheet.getRow(rowNumber);
      for (let column = 1; column <= 2; column += 1) {
        assert.deepEqual(
          row.getCell(column).alignment,
          { horizontal: 'center', vertical: 'middle' },
          `${sheet.name} 第 ${rowNumber} 列第 ${column} 欄沒有置中`,
        );
      }
    }
  }
});

test('逐案清單的 TEMSIS 完整顯示，不遮成末 4 碼', () => {
  const { detail } = buildLists();
  assert.equal(detail.getCell(3, 3).value, ROWS[0]['TEMSIS ID']);
  assert.equal(detail.getCell(2, 3).value, 'TEMSIS');
});

test('欄寬容得下最長的內容，文字不會被遮住', () => {
  const { detail } = buildLists();
  for (let column = 1; column <= 3; column += 1) {
    const widest = Math.max(
      ...[2, 3, 4, 5].map((row) => displayWidth(detail.getCell(row, column).value)),
    );
    assert.ok(
      detail.getColumn(column).width >= widest,
      `第 ${column} 欄寬 ${detail.getColumn(column).width} 放不下 ${widest} 格寬的內容`,
    );
  }
});

test('合併的大標放得下（合併儲存格放不下會直接被切掉）', () => {
  const { summary } = buildLists();
  const total = [1, 2].reduce((sum, column) => sum + summary.getColumn(column).width, 0);
  // 標題字級 14，換算成預設字型的字元數。
  const needed = (displayWidth(summary.getCell(1, 1).value) * 14) / 11;
  assert.ok(total >= needed, `兩欄合計 ${total} 放不下標題所需的 ${needed}`);
});

test('各分隊件數：合計在第一列，其餘依件數由多到少', () => {
  const { summary, squadCount } = buildLists();
  assert.equal(squadCount, 2);
  assert.deepEqual([summary.getCell(3, 1).value, summary.getCell(3, 2).value], ['合計', 3]);
  assert.deepEqual([summary.getCell(4, 1).value, summary.getCell(4, 2).value], ['蘆竹分隊', 2]);
  assert.deepEqual([summary.getCell(5, 1).value, summary.getCell(5, 2).value], ['山峰分隊', 1]);
});

test('有EKG處置無12導程清冊：版面一樣，但用語不可以跟另一份混在一起', () => {
  const { workbook, squadCount } = buildEkgOnlyWorkbook(ROWS, COLUMNS, MONTH);
  const summary = workbook.getWorksheet('各分隊件數');
  const detail = workbook.getWorksheet('逐案清單');
  const expected = `${MONTH.label}　有EKG處置無12導程清冊`;

  assert.equal(summary.getCell(1, 1).value, expected);
  assert.equal(detail.getCell(1, 1).value, expected);
  // 這一份不是「漏勾」——漏勾的是另一份，兩份用同一個欄名會讓人拿錯清單去提醒同仁。
  assert.equal(summary.getCell(2, 2).value, '件數');
  assert.equal(squadCount, 2);
  // 逐案清單的欄位與 TEMSIS 完整顯示比照另一份，才能拿著回系統把案件叫出來。
  assert.deepEqual(
    [detail.getCell(2, 1).value, detail.getCell(2, 2).value, detail.getCell(2, 3).value],
    ['分隊', '案件日期', 'TEMSIS'],
  );
  assert.equal(detail.getCell(3, 3).value, ROWS[0]['TEMSIS ID']);
});

test('待人工確認清冊：標題兩列置中，TEMSIS 也完整顯示', () => {
  const workbook = buildPendingWorkbook(
    [{
      squad: '內壢分隊',
      caseDate: '2026/07/09 03:11:00',
      temsis: '2026070910100310380401',
      arrival: null,
      upload: '2026/07/09 03:40:00',
      verdict: '無法判定',
      reason: '讀不到送達醫院時間',
    }],
    MONTH,
  );
  const sheet = workbook.getWorksheet('待人工確認');
  assert.equal(sheet.getCell(1, 1).value, `${MONTH.label}　心電圖待人工確認清冊`);
  assert.deepEqual(sheet.getRow(2).getCell(1).alignment, { horizontal: 'center', vertical: 'middle' });
  // 這份也是拿著回系統把案件叫出來用的，遮起來反而不好對（使用者 2026-08-06 決定）。
  assert.equal(sheet.getCell(2, 3).value, 'TEMSIS');
  assert.equal(sheet.getCell(3, 3).value, '2026070910100310380401');
});
