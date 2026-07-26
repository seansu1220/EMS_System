/**
 * 報表輸出：終端機表格 + Excel 檔。
 *
 * ⚠ 個資原則：這裡輸出的內容只有分隊名稱與統計數字，不含任何個人資料，
 *   因此產出的報表可以安全地帶著走或轉寄。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import XLSX from './xlsxNode.mjs';
import { PATHS } from './config.mjs';
import { formatRatio } from './aggregate.mjs';
import { log } from './logger.mjs';

/** 報表欄位標題（配置驅動，改欄名只改這裡）。 */
const COLUMNS = ['分隊', '到院前預警案件數', '總案件數', '預警比率'];

/** 計算字串在等寬終端機的顯示寬度（中日韓字元佔 2 格）。 */
function displayWidth(text) {
  return [...text].reduce((width, char) => width + (/[ᄀ-ￜ]/.test(char) ? 2 : 1), 0);
}

/** 將字串補齊到指定顯示寬度。 */
function padToWidth(text, width, align = 'left') {
  const padding = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'right' ? padding + text : text + padding;
}

/** 把一筆統計轉成表格用的字串陣列。 */
function toRowTexts(stat) {
  return [stat.squad, String(stat.alertCount), String(stat.totalCount), formatRatio(stat.ratio)];
}

/**
 * 在終端機印出比較表。
 * @param {import('./aggregate.mjs').SquadStat[]} stats
 * @param {import('./aggregate.mjs').SquadStat} summary
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 */
export function printReport(stats, summary, monthRange) {
  const bodyRows = [...stats.map(toRowTexts), toRowTexts(summary)];
  const widths = COLUMNS.map((header, index) =>
    Math.max(displayWidth(header), ...bodyRows.map((row) => displayWidth(row[index]))),
  );
  const renderRow = (cells) =>
    '  ' + cells.map((cell, index) => padToWidth(cell, widths[index], index === 0 ? 'left' : 'right')).join('  ');

  console.log(`\n各分隊到院前預警比率　${monthRange.start} ~ ${monthRange.end}`);
  console.log(renderRow(COLUMNS));
  console.log('  ' + widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of stats.map(toRowTexts)) console.log(renderRow(row));
  console.log('  ' + widths.map((width) => '─'.repeat(width)).join('  '));
  console.log(renderRow(toRowTexts(summary)));
}

/**
 * 寫出 Excel 報表。
 * @param {import('./aggregate.mjs').SquadStat[]} stats
 * @param {import('./aggregate.mjs').SquadStat} summary
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string>} 報表檔路徑
 */
export async function writeReport(stats, summary, monthRange) {
  await fs.mkdir(PATHS.reportDir, { recursive: true });

  // 比率以數值寫入並套百分比格式，方便使用者在 Excel 內再排序或畫圖。
  const sheetData = [
    [`各分隊到院前預警比率（${monthRange.start} ~ ${monthRange.end}）`],
    [],
    COLUMNS,
    ...stats.map((stat) => [stat.squad, stat.alertCount, stat.totalCount, stat.ratio]),
    [],
    [summary.squad, summary.alertCount, summary.totalCount, summary.ratio],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetData);
  sheet['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }];
  for (const cell of Object.keys(sheet)) {
    if (cell.startsWith('D') && typeof sheet[cell].v === 'number') sheet[cell].z = '0.0%';
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '到院前預警比率');
  const filePath = path.join(PATHS.reportDir, `到院前預警比率-${monthRange.label}.xlsx`);
  XLSX.writeFile(workbook, filePath);
  log.ok(`報表已產出：${path.relative(process.cwd(), filePath)}`);
  return filePath;
}
