/**
 * 報表輸出：終端機表格 + Excel 檔（兩個分頁）。
 *
 * 格式比照使用者既有的報表：
 *   分頁一「到院前預警比例」：各大隊合計 ＋ 其轄下分隊
 *   分頁二「排序」：各分隊依到院前預警率由高到低
 *
 * ⚠ 個資原則：這裡輸出的內容只有單位名稱與統計數字，不含任何個人資料，
 *   因此產出的報表可以安全地帶著走或轉寄。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import XLSX from './xlsxNode.mjs';
import { PATHS, REPORT_FORMAT } from './config.mjs';
import { formatRatio } from './aggregate.mjs';
import { log } from './logger.mjs';

/** 報表標題，例如「本局6/1-6/30到院前預警案件執行率」。 */
function buildTitle(monthRange) {
  const toMonthDay = (isoDate) => {
    const [, month, day] = isoDate.split('-');
    return `${Number(month)}/${Number(day)}`;
  };
  return `本局${toMonthDay(monthRange.start)}-${toMonthDay(monthRange.end)}到院前預警案件執行率`;
}

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

/** 印出一張對齊的表格。 */
function printTable(heading, stats) {
  const headers = ['單位', ...REPORT_FORMAT.columns.slice(1)];
  const bodyRows = stats.map(toRowTexts);
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...bodyRows.map((row) => displayWidth(row[index]))),
  );
  const renderRow = (cells) =>
    '  ' +
    cells.map((cell, index) => padToWidth(cell, widths[index], index === 0 ? 'left' : 'right')).join('  ');

  console.log(`\n${heading}`);
  console.log(renderRow(headers));
  console.log('  ' + widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of bodyRows) console.log(renderRow(row));
}

/**
 * 在終端機印出結果：先看各大隊，再看各分隊排名。
 * @param {import('./aggregate.mjs').GroupedStat[]} groupedRows
 * @param {import('./aggregate.mjs').SquadStat[]} sortedStats
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 */
export function printReport(groupedRows, sortedStats, monthRange) {
  console.log(`\n${buildTitle(monthRange)}`);
  printTable('各大隊', groupedRows.filter((row) => row.level === 'brigade'));
  printTable('各分隊（依到院前預警率由高到低）', sortedStats);
}

/** 建立一個分頁：標題列（跨欄合併）＋ 欄位標題 ＋ 資料列。 */
function buildSheet(title, stats) {
  const sheetData = [
    [title],
    REPORT_FORMAT.columns,
    ...stats.map((stat) => [stat.squad, stat.alertCount, stat.totalCount, stat.ratio]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetData);
  sheet['!cols'] = REPORT_FORMAT.columnWidths.map((width) => ({ wch: width }));
  sheet['!merges'] = [{ s: { c: 0, r: 0 }, e: { c: REPORT_FORMAT.columns.length - 1, r: 0 } }];

  // 比率欄以數值寫入並套百分比格式，使用者可直接在 Excel 內再排序或製圖。
  for (const cellRef of Object.keys(sheet)) {
    if (cellRef.startsWith('D') && typeof sheet[cellRef].v === 'number') {
      sheet[cellRef].z = REPORT_FORMAT.ratioNumberFormat;
    }
  }
  return sheet;
}

/**
 * 寫出 Excel 報表（兩個分頁）。
 * @param {import('./aggregate.mjs').GroupedStat[]} groupedRows 大隊＋轄下分隊
 * @param {import('./aggregate.mjs').SquadStat[]} sortedStats 各分隊依預警率排序
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string>} 報表檔路徑
 */
export async function writeReport(groupedRows, sortedStats, monthRange) {
  await fs.mkdir(PATHS.reportDir, { recursive: true });
  const title = buildTitle(monthRange);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildSheet(title, groupedRows), REPORT_FORMAT.sheets.grouped);
  XLSX.utils.book_append_sheet(workbook, buildSheet(title, sortedStats), REPORT_FORMAT.sheets.sorted);

  const filePath = path.join(PATHS.reportDir, `到院前預警比率-${monthRange.label}.xlsx`);
  XLSX.writeFile(workbook, filePath);
  log.ok(`報表已產出：${path.relative(process.cwd(), filePath)}`);
  return filePath;
}
