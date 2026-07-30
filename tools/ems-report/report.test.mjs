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

/**
 * 取得儲存格的實心底色 argb（沒有實心底色則回傳 null）。
 * 需檢查 `pattern === 'solid'`：有設定框線的儲存格讀回時會帶
 * `{type:'pattern', pattern:'none'}`，只看 type 會誤判成有底色。
 */
function fillArgbOf(cell) {
  return cell.fill?.pattern === 'solid' ? (cell.fill.fgColor?.argb ?? null) : null;
}

/** 中日韓字元佔兩個字元寬。 */
function displayWidth(text) {
  return [...String(text)].reduce((width, char) => width + (/[ᄀ-ￜ]/.test(char) ? 2 : 1), 0);
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

test('每一格都有四邊框線且文字置中', () => {
  const workbook = buildWorkbook(GROUPED, SORTED, MONTH_RANGE);
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row, rowNumber) => {
      for (let column = 1; column <= REPORT_FORMAT.columns.length; column += 1) {
        const cell = row.getCell(column);
        const border = cell.border ?? {};
        for (const side of ['top', 'left', 'bottom', 'right']) {
          assert.equal(border[side]?.style, REPORT_FORMAT.borderStyle,
            `${sheet.name} 第 ${rowNumber} 列第 ${column} 欄缺 ${side} 框線`);
        }
        assert.equal(cell.alignment?.horizontal, 'center');
        assert.equal(cell.alignment?.vertical, 'middle');
      }
    });
  }
});

test('內文字級為 12、標題列為 16', () => {
  const workbook = buildWorkbook(GROUPED, SORTED, MONTH_RANGE);
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row, rowNumber) => {
      const expected = rowNumber === 1 ? REPORT_FORMAT.titleFontSize : REPORT_FORMAT.fontSize;
      for (let column = 1; column <= REPORT_FORMAT.columns.length; column += 1) {
        assert.equal(row.getCell(column).font?.size, expected,
          `${sheet.name} 第 ${rowNumber} 列第 ${column} 欄字級應為 ${expected}`);
      }
    });
  }
});

test('大隊列上色後仍保有框線與字級（樣式不互相覆蓋）', () => {
  const sheet = buildWorkbook(GROUPED, SORTED, MONTH_RANGE).getWorksheet(REPORT_FORMAT.sheets.grouped);
  const cell = sheet.getRow(3).getCell(1);
  assert.equal(fillArgbOf(cell), REPORT_FORMAT.brigadeRowStyle.fillArgb);
  assert.equal(cell.font.bold, true);
  assert.equal(cell.font.size, REPORT_FORMAT.fontSize, '上色不可把字級蓋掉');
  assert.equal(cell.border.left.style, REPORT_FORMAT.borderStyle, '上色不可把框線蓋掉');
});

test('欄寬足以容納最長的內容，文字不會被截斷', () => {
  const workbook = buildWorkbook(GROUPED, SORTED, MONTH_RANGE);
  const scale = REPORT_FORMAT.fontSize / 11;
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 標題列跨欄合併，不受單欄寬度限制
      for (let column = 1; column <= REPORT_FORMAT.columns.length; column += 1) {
        const value = row.getCell(column).value;
        const text = column === 4 && typeof value === 'number'
          ? `${(value * 100).toFixed(2)}%`
          : String(value ?? '');
        assert.ok(displayWidth(text) * scale <= sheet.getColumn(column).width,
          `${sheet.name} 第 ${rowNumber} 列第 ${column} 欄「${text}」放不下`);
      }
    });
  }
});

test('標題列與資料列都有設定列高', () => {
  const sheet = buildWorkbook(GROUPED, SORTED, MONTH_RANGE).getWorksheet(REPORT_FORMAT.sheets.grouped);
  assert.equal(sheet.getRow(1).height, REPORT_FORMAT.titleRowHeight);
  assert.equal(sheet.getRow(3).height, REPORT_FORMAT.rowHeight);
});
