/**
 * 匯出檔讀取：把系統匯出的 Excel 轉成「欄位標題 + 資料列」。
 *
 * ⚠ 個資原則：本模組會把個案明細讀進記憶體（統計必需），但
 *   - 不寫出任何含明細的檔案
 *   - 診斷用的 `describeWorkbook` 只回報欄名與筆數，不回報任何資料格內容
 */
import XLSX from './xlsxNode.mjs';

/**
 * @typedef {Object} TableData
 * @property {string} sheetName 使用的工作表名稱
 * @property {string[]} headers 欄位標題
 * @property {Record<string, unknown>[]} rows 資料列
 * @property {number} headerRowIndex 標題列在原檔的列索引（0 起算）
 */

/** 讀取檔案並取得第一個工作表的二維陣列。 */
function readSheetMatrix(filePath) {
  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`無法讀取匯出檔 ${filePath}：${reason}`);
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error(`匯出檔 ${filePath} 沒有任何工作表`);
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: '',
    blankrows: false,
  });
  return { sheetName, matrix };
}

/** 儲存格轉為乾淨的字串（去除換行與前後空白）。 */
function toText(cell) {
  return String(cell ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 找出標題列所在的列索引。
 * 政府系統的匯出檔常在最上方加報表名稱、查詢條件等說明列，
 * 因此不能假設第一列就是欄位標題，改為找「含有指定欄名」的那一列。
 *
 * @param {unknown[][]} matrix
 * @param {readonly string[]} expectedColumns 預期會出現的欄名（任一即可）
 * @returns {number} 找不到時回傳 -1
 */
export function findHeaderRowIndex(matrix, expectedColumns) {
  const normalize = (text) => toText(text).replace(/\s/g, '');
  const wanted = expectedColumns.map(normalize);
  return matrix.findIndex((row) =>
    row.some((cell) => {
      const value = normalize(cell);
      return value !== '' && wanted.some((column) => value === column || value.includes(column));
    }),
  );
}

/**
 * 讀取匯出檔為表格資料。
 * @param {string} filePath
 * @param {readonly string[]} expectedColumns 用來定位標題列的欄名候選
 * @returns {TableData}
 */
export function readTable(filePath, expectedColumns) {
  const { sheetName, matrix } = readSheetMatrix(filePath);
  const headerRowIndex = findHeaderRowIndex(matrix, expectedColumns);
  if (headerRowIndex < 0) {
    const preview = matrix.slice(0, 3).map((row) => row.map(toText).filter(Boolean).join(' | '));
    throw new Error(
      `在 ${filePath} 找不到欄位標題列（預期含有：${expectedColumns.join('、')}）。` +
        `前幾列看起來像：${preview.join(' ／ ')}`,
    );
  }

  const headers = matrix[headerRowIndex].map(toText);
  const rows = matrix.slice(headerRowIndex + 1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row[index] ?? '';
    });
    return record;
  });
  return { sheetName, headers, rows, headerRowIndex };
}

/**
 * 只回報結構的診斷資訊（欄名與筆數），供匯出檔格式改變時排查用。
 * 刻意不回傳任何資料格內容，避免個資外流。
 * @param {string} filePath
 * @returns {{sheetName: string, rowCount: number, columnCount: number, firstRowTexts: string[]}}
 */
export function describeWorkbook(filePath) {
  const { sheetName, matrix } = readSheetMatrix(filePath);
  return {
    sheetName,
    rowCount: matrix.length,
    columnCount: Math.max(0, ...matrix.map((row) => row.length)),
    // 只取第一列（通常是報表標題或欄位標題），且截斷長度，不取任何資料列。
    firstRowTexts: (matrix[0] ?? []).map((cell) => toText(cell).slice(0, 30)),
  };
}
