/**
 * 報表輸出的測試：在記憶體中組出活頁簿並檢查結構與樣式。
 *
 * 刻意用 `buildWorkbook` 而非 `writeReport`，避免測試覆寫使用者目前的報表檔。
 *
 * 背景：輸出改用 ExcelJS 是因為 **SheetJS 免費版不會寫入儲存格底色**
 * （樣式屬付費功能，寫進去讀回來會變成 `patternType: none`），無法標示大隊列。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkbook } from './report.mjs';
import { REPORT_FORMAT } from './config.mjs';

const MONTH_RANGE = { label: '2026-06', start: '2026-06-01', end: '2026-06-30' };

const GROUPED = [
  { squad: '第一大隊', alertCount: 90, totalCount: 100, ratio: 0.9, level: 'brigade' },
  { squad: '桃園分隊', alertCount: 50, totalCount: 55, ratio: 50 / 55, level: 'squad' },
  { squad: '大林分隊', alertCount: 40, totalCount: 45, ratio: 40 / 45, level: 'squad' },
];
const SORTED = [
  { squad: '桃園分隊', alertCount: 50, totalCount: 55, ratio: 50 / 55 },
  { squad: '大林分隊', alertCount: 40, totalCount: 45, ratio: 40 / 45 },
];

/** 取得儲存格的底色 argb（沒有底色則回傳 null）。 */
function fillArgbOf(cell) {
  return cell.fill?.type === 'pattern' ? (cell.fill.fgColor?.argb ?? null) : null;
}

test('報表有兩個分頁，標題跨欄合併', () => {
  const workbook = buildWorkbook(GROUPED, SORTED, MONTH_RANGE);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    [REPORT_FORMAT.sheets.grouped, REPORT_FORMAT.sheets.sorted],
  );
  const sheet = workbook.getWorksheet(REPORT_FORMAT.sheets.grouped);
  assert.equal(sheet.getCell('A1').value, '本局6/1-6/30到院前預警案件執行率');
  assert.ok(sheet.getCell('A1').isMerged, '標題列需跨欄合併');
  assert.deepEqual(sheet.getRow(2).values.slice(1), [...REPORT_FORMAT.columns]);
});

test('大隊列有紅色底色，分隊列沒有', () => {
  const sheet = buildWorkbook(GROUPED, SORTED, MONTH_RANGE).getWorksheet(REPORT_FORMAT.sheets.grouped);
  const expected = REPORT_FORMAT.brigadeRowStyle.fillArgb;

  // 第 3 列＝第一大隊、第 4~5 列＝轄下分隊
  for (let column = 1; column <= REPORT_FORMAT.columns.length; column += 1) {
    assert.equal(fillArgbOf(sheet.getRow(3).getCell(column)), expected, `大隊列第 ${column} 欄要上色`);
  }
  assert.equal(sheet.getRow(3).getCell(1).font.bold, true, '大隊列要粗體');
  assert.equal(sheet.getRow(3).getCell(1).font.color.argb, REPORT_FORMAT.brigadeRowStyle.fontArgb);

  assert.equal(fillArgbOf(sheet.getRow(4).getCell(1)), null, '分隊列不可上色');
  assert.equal(fillArgbOf(sheet.getRow(5).getCell(1)), null, '分隊列不可上色');
});

test('排序分頁沒有大隊，因此完全不上色', () => {
  const sheet = buildWorkbook(GROUPED, SORTED, MONTH_RANGE).getWorksheet(REPORT_FORMAT.sheets.sorted);
  for (const rowNumber of [3, 4]) {
    assert.equal(fillArgbOf(sheet.getRow(rowNumber).getCell(1)), null);
  }
});

test('比率以數值寫入並套百分比格式', () => {
  const sheet = buildWorkbook(GROUPED, SORTED, MONTH_RANGE).getWorksheet(REPORT_FORMAT.sheets.grouped);
  const cell = sheet.getRow(3).getCell(4);
  assert.equal(typeof cell.value, 'number', '比率須為數值，方便在 Excel 內再排序或製圖');
  assert.equal(cell.value, 0.9);
  assert.equal(cell.numFmt, REPORT_FORMAT.ratioNumberFormat);
});

test('數字欄位原樣寫入，不做四捨五入或轉字串', () => {
  const sheet = buildWorkbook(GROUPED, SORTED, MONTH_RANGE).getWorksheet(REPORT_FORMAT.sheets.grouped);
  assert.equal(sheet.getRow(4).getCell(1).value, '桃園分隊');
  assert.equal(sheet.getRow(4).getCell(2).value, 50);
  assert.equal(sheet.getRow(4).getCell(3).value, 55);
});
