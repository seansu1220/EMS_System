/**
 * Excel 版面計算（純函式，不碰 ExcelJS、不碰檔案）。
 *
 * 為什麼要抽出來：正式報表（`report.mjs`）與兩份附帶清單（`ekgLists.mjs`）
 * 各自算過一次欄寬，算法卻不一樣——清單那份只看欄名不看內容，
 * 於是「案件日期」這種 4 個字的欄名配上 `2026/07/01 09:04:50` 的值就被截掉
 * （使用者 2026-08-05 回報「有文字被遮住」）。抽成同一份之後兩邊一起修好。
 */
import { REPORT_FORMAT } from './config.mjs';

/**
 * 字串在等寬環境下的顯示寬度（中日韓字元佔 2 格）。
 * 終端機表格與 Excel 欄寬都用這個當基準。
 *
 * @param {unknown} text
 * @returns {number}
 */
export function displayWidth(text) {
  return [...String(text ?? '')].reduce(
    (width, char) => width + (/[ᄀ-ￜ]/.test(char) ? 2 : 1),
    0,
  );
}

/**
 * 一段文字需要多寬的 Excel 欄位才放得下。
 *
 * Excel 的欄寬以「預設字型（11pt）的字元數」為單位，因此字級放大時
 * 同樣的字要按比例換算，最後再加上左右邊距。
 *
 * @param {unknown} text
 * @param {number} [fontSize] 該儲存格的字級
 * @param {number} [padding] 左右邊距（字元數）
 * @returns {number}
 */
export function excelWidthFor(text, fontSize = 11, padding = 3) {
  return Math.ceil((displayWidth(text) * fontSize) / 11) + padding;
}

/**
 * 依「欄名 ＋ 所有資料列」算出每一欄的寬度。
 *
 * ⚠ 一定要把資料列算進去：只看欄名的話，欄名短、值長的欄位一定會被截掉。
 *
 * @param {string[]} header 欄名
 * @param {unknown[][]} rows 資料列（與欄名同順序）
 * @param {{fontSize?: number, minWidth?: number, maxWidth?: number,
 *   wideColumns?: string[], wideWidth?: number}} [options]
 *   `wideColumns`：指定欄名直接給 `wideWidth`（說明類欄位放寬，但不隨內容無限長）
 * @returns {number[]}
 */
export function computeColumnWidths(header, rows, options = {}) {
  const {
    fontSize = 11,
    minWidth = 10,
    maxWidth = 40,
    wideColumns = [],
    wideWidth = 60,
  } = options;
  return header.map((name, index) => {
    if (wideColumns.includes(name)) return wideWidth;
    const widest = Math.max(
      excelWidthFor(name, fontSize),
      ...rows.map((row) => excelWidthFor(row?.[index], fontSize)),
    );
    return Math.min(maxWidth, Math.max(minWidth, widest));
  });
}

/**
 * 一個**粗體標題**需要多寬才放得下，含餘裕。
 *
 * 與 {@link excelWidthFor} 分開是因為標題有兩個內文沒有的問題：粗體比較寬，
 * 而且它在合併儲存格裡放不下就直接被切掉（見 `REPORT_FORMAT.titleWidthFactor`）。
 *
 * @param {string} title
 * @param {number} fontSize
 * @returns {number}
 */
export function titleWidthFor(title, fontSize) {
  return Math.ceil(excelWidthFor(title, fontSize) * REPORT_FORMAT.titleWidthFactor);
}

/**
 * 確保跨欄合併的標題放得下。
 *
 * 合併儲存格**不會**像一般儲存格那樣把文字溢出到隔壁——放不下就直接被切掉。
 * 標題字級通常大於內文，欄位又少的時候（例如只有兩欄的「各分隊件數」）
 * 很容易發生。差額補在最寬的那一欄，看起來最自然。
 *
 * @param {number[]} widths 各欄寬度
 * @param {string} title 合併後的標題文字
 * @param {number} fontSize 標題字級
 * @returns {number[]} 調整後的寬度（原陣列不變）
 */
export function widenToFitTitle(widths, title, fontSize) {
  const adjusted = [...widths];
  if (adjusted.length === 0) return adjusted;
  const needed = titleWidthFor(title, fontSize);
  const total = adjusted.reduce((sum, width) => sum + width, 0);
  if (total >= needed) return adjusted;
  const widestIndex = adjusted.indexOf(Math.max(...adjusted));
  adjusted[widestIndex] += needed - total;
  return adjusted;
}
