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
import ExcelJS from 'exceljs';
import { PATHS, REPORT_FORMAT } from './config.mjs';
import { formatRatio } from './aggregate.mjs';
import { log } from './logger.mjs';

// 輸出改用 ExcelJS 而非 SheetJS：SheetJS 的免費版**不會寫入儲存格底色**
// （樣式屬付費功能，寫進去讀回來會變成 patternType: none），無法標示大隊列。
// 讀取匯出檔仍用 SheetJS，因為 ExcelJS 不支援舊的 .xls 格式。

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

/** 四邊皆為一般粗細的框線。 */
function thinBorder() {
  const style = REPORT_FORMAT.borderStyle;
  return { top: { style }, left: { style }, bottom: { style }, right: { style } };
}

/** 逐格套用框線與置中（含合併的標題列，否則合併範圍右側會缺框線）。 */
function applyGridStyle(row, fontSize) {
  for (let column = 1; column <= REPORT_FORMAT.columns.length; column += 1) {
    const cell = row.getCell(column);
    cell.border = thinBorder();
    cell.alignment = { ...REPORT_FORMAT.alignment };
    cell.font = { ...(cell.font ?? {}), size: fontSize };
  }
}

/** 把大隊列標成紅底，方便一眼與轄下分隊區分。 */
function applyBrigadeStyle(row) {
  const { fillArgb, fontArgb, bold } = REPORT_FORMAT.brigadeRowStyle;
  for (let column = 1; column <= REPORT_FORMAT.columns.length; column += 1) {
    const cell = row.getCell(column);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
    cell.font = { ...(cell.font ?? {}), bold, color: { argb: fontArgb } };
  }
}

/**
 * 依內容計算欄寬，避免文字被截掉。
 *
 * Excel 的欄寬以「預設字型的字元數」為單位，而中日韓字元約佔兩個字元寬，
 * 且本報表字級為 12（大於預設的 11），故加上比例與邊距後再取整。
 *
 * @param {{squad: string, alertCount: number, totalCount: number, ratio: number|null}[]} stats
 * @returns {number[]}
 */
function computeColumnWidths(stats) {
  const textRows = [
    [...REPORT_FORMAT.columns],
    ...stats.map((stat) => toRowTexts(stat)),
  ];
  const scale = REPORT_FORMAT.fontSize / 11;
  const padding = 3;
  return REPORT_FORMAT.columns.map((_, index) => {
    const widest = Math.max(...textRows.map((row) => displayWidth(String(row[index] ?? ''))));
    const minimum = REPORT_FORMAT.columnWidths[index] ?? 10;
    return Math.max(minimum, Math.ceil(widest * scale) + padding);
  });
}

/**
 * 建立一個分頁：標題列（跨欄合併）＋ 欄位標題 ＋ 資料列。
 * @param {import('exceljs').Workbook} workbook
 * @param {string} sheetName
 * @param {string} title
 * @param {(import('./aggregate.mjs').SquadStat & {level?: string})[]} stats
 */
function buildSheet(workbook, sheetName, title, stats) {
  const sheet = workbook.addWorksheet(sheetName);

  const titleRow = sheet.addRow([title]);
  sheet.mergeCells(1, 1, 1, REPORT_FORMAT.columns.length);
  titleRow.getCell(1).font = { bold: true };
  titleRow.height = REPORT_FORMAT.titleRowHeight;
  applyGridStyle(titleRow, REPORT_FORMAT.titleFontSize);

  const headerRow = sheet.addRow(REPORT_FORMAT.columns);
  for (let column = 1; column <= REPORT_FORMAT.columns.length; column += 1) {
    headerRow.getCell(column).font = { bold: REPORT_FORMAT.headerRowStyle.bold };
  }
  headerRow.height = REPORT_FORMAT.rowHeight;
  applyGridStyle(headerRow, REPORT_FORMAT.fontSize);

  for (const stat of stats) {
    const row = sheet.addRow([stat.squad, stat.alertCount, stat.totalCount, stat.ratio]);
    // 比率以數值寫入並套百分比格式，使用者可直接在 Excel 內再排序或製圖。
    row.getCell(4).numFmt = REPORT_FORMAT.ratioNumberFormat;
    row.height = REPORT_FORMAT.rowHeight;
    if (stat.level === 'brigade') applyBrigadeStyle(row);
    // 框線與字級最後套，才不會被大隊樣式覆蓋掉。
    applyGridStyle(row, REPORT_FORMAT.fontSize);
  }

  computeColumnWidths(stats).forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  return sheet;
}

/**
 * 組出報表活頁簿（不寫檔）。與 `writeReport` 分開，讓測試能在記憶體中檢查樣式，
 * 而不會覆寫使用者目前的報表檔。
 *
 * @param {import('./aggregate.mjs').GroupedStat[]} groupedRows 大隊＋轄下分隊
 * @param {import('./aggregate.mjs').SquadStat[]} sortedStats 各分隊依預警率排序
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {import('exceljs').Workbook}
 */
export function buildWorkbook(groupedRows, sortedStats, monthRange) {
  const title = buildTitle(monthRange);
  const workbook = new ExcelJS.Workbook();
  buildSheet(workbook, REPORT_FORMAT.sheets.grouped, title, groupedRows);
  buildSheet(workbook, REPORT_FORMAT.sheets.sorted, title, sortedStats);
  return workbook;
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
  const workbook = buildWorkbook(groupedRows, sortedStats, monthRange);
  const filePath = path.join(PATHS.reportDir, `到院前預警比率-${monthRange.label}.xlsx`);

  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (error) {
    // Excel 開著同一個檔案時會鎖住它，Node 只會拋出 EBUSY／EPERM 這種看不懂的訊息。
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(
        `報表檔正被其他程式開啟（通常是 Excel），無法覆寫：${filePath}\n` +
          '請關閉該檔案後重新執行；查詢結果不需要重跑，只差寫檔這一步。',
      );
    }
    throw error;
  }

  log.ok(`報表已產出：${path.relative(process.cwd(), filePath)}`);
  return filePath;
}
