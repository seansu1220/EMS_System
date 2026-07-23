/**
 * 剪貼簿表格解析純邏輯（無第三方依賴，純函式）。
 * 供「表格轉 Excel」小工具將貼上的文字轉為二維陣列。
 */

/**
 * 將剪貼簿貼上的表格文字解析為二維字串陣列。
 * 規則：
 * - 先依換行（\r\n 或 \n）拆列，並去除尾端的空白列。
 * - 若整份文字含 Tab（\t）：每列以 \t 拆欄（由網頁 / Excel 複製的標準格式）。
 * - 若完全沒有 \t 且多數列含逗號：改以逗號做簡易 CSV 拆欄。
 *   注意：此為基本 split，不處理引號包覆與跳脫（如 "a,b" 內的逗號），足以應付一般貼上。
 * - 其餘情況：每列視為單一欄。
 * @param text 貼上的原始文字
 * @returns 二維字串陣列（列 × 欄）；空輸入回傳空陣列
 */
export function parseClipboardTable(text: string): string[][] {
  if (!text) return [];
  // 拆列並移除尾端空白列（保留中間空列以維持列對齊）。
  const lines = text.split(/\r\n|\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) return [];

  const hasTab = text.includes('\t');
  if (hasTab) {
    return lines.map((line) => line.split('\t'));
  }

  // 無 Tab：判斷是否多數列含逗號，是則以逗號拆欄。
  const linesWithComma = lines.filter((line) => line.includes(',')).length;
  const useComma = linesWithComma > lines.length / 2;
  if (useComma) {
    return lines.map((line) => line.split(','));
  }

  // 皆非：每列單欄。
  return lines.map((line) => [line]);
}
