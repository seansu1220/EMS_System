/**
 * 估算 Excel 儲存格放得下多少字——產出檔不開 Excel，只能用字型尺寸換算。
 *
 * 為什麼需要：ExcelJS 不會像 Excel 那樣自動調列高，列高寫死時，
 * 換行後超出的那幾行會被**切掉**（畫面上只看到一半的字，也不會有任何提示）。
 * 2026-10-05 的交通案件來文就是這樣：範本是 14 號字、列高 33.6，連兩行都塞不下。
 *
 * 估算刻意**偏保守**（寧可列高多一點，也不要切字），換算參數放在
 * `config.mjs` 的 `TRAFFIC_CASE_REPORT.layout.autoFit`。
 *
 * 全部是純函式，不碰 ExcelJS，方便單獨測試。
 */

/**
 * @typedef {Object} AutoFitParams
 * @property {number} pxPerWidthUnit   欄寬 1 單位的像素（Excel 預設字型 Calibri 11 的數字寬度）
 * @property {number} columnPaddingPx  Excel 換算欄寬時額外加上的像素
 * @property {number} cellInnerMarginPx 儲存格左右內距合計，這段不能放字
 * @property {number} safetyRatio      可用寬度再打的折扣（斷行位置、字型替代造成的誤差）
 * @property {number} lineHeightRatio  一行的高度＝字級 × 這個倍數（點）
 * @property {number} rowPaddingPt     列高上下額外留白（點）
 */

/** 1 點（pt）等於幾像素（96 DPI）。 */
const PX_PER_PT = 96 / 72;

/**
 * 判斷一個字元是不是全形（中日韓文字、全形標點）。
 * 半形（英數、半形標點）的寬度約是全形的一半。
 *
 * @param {string} char
 * @returns {boolean}
 */
function isFullWidth(char) {
  const code = char.codePointAt(0) ?? 0;
  // FF61~FFDC 是半形片假名與半形韓文，雖在「全形區塊」裡但寬度是半形。
  if (code >= 0xff61 && code <= 0xffdc) return false;
  return code >= 0x2e80;
}

/**
 * 一段文字（不含換行）以指定字級排出來的寬度（像素）。
 *
 * @param {string} text
 * @param {number} fontSizePt
 * @returns {number}
 */
export function textWidthPx(text, fontSizePt) {
  const emPx = fontSizePt * PX_PER_PT;
  let width = 0;
  for (const char of text) width += isFullWidth(char) ? emPx : emPx / 2;
  return width;
}

/**
 * 儲存格實際可以放字的寬度（像素）。
 *
 * @param {number} columnWidth Excel 的欄寬值（例如 26.22）
 * @param {AutoFitParams} params
 * @returns {number}
 */
export function usableCellWidthPx(columnWidth, params) {
  const columnPx = columnWidth * params.pxPerWidthUnit + params.columnPaddingPx;
  return Math.max(1, (columnPx - params.cellInnerMarginPx) * params.safetyRatio);
}

/**
 * 估算文字在儲存格內自動換行後會佔幾行。
 * 文字本身的換行（`\n`）各自起新的一行；空字串算 1 行。
 *
 * @param {string} text
 * @param {number} columnWidth
 * @param {number} fontSizePt
 * @param {AutoFitParams} params
 * @returns {number}
 */
export function estimateLineCount(text, columnWidth, fontSizePt, params) {
  const usable = usableCellWidthPx(columnWidth, params);
  return String(text ?? '')
    .split('\n')
    .reduce((lines, paragraph) => lines + Math.max(1, Math.ceil(textWidthPx(paragraph, fontSizePt) / usable)), 0);
}

/**
 * 放得下指定行數的列高（點），不低於 `minHeight`。取到小數一位。
 *
 * @param {number} lineCount
 * @param {number} fontSizePt
 * @param {AutoFitParams} params
 * @param {number} minHeight 版面規定的最低列高（範本的列高）
 * @returns {number}
 */
export function rowHeightForLines(lineCount, fontSizePt, params, minHeight) {
  const needed = lineCount * fontSizePt * params.lineHeightRatio + params.rowPaddingPt;
  return Math.max(minHeight, Math.ceil(needed * 10) / 10);
}
