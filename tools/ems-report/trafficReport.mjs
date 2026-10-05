/**
 * 二級以上因交通事故救護案件——把整理好的列排成「來文格式」並存檔。
 *
 * 版面（標題、欄寬、字型、框線）全部照抄自上級發文的空白格式，寫在
 * `config.mjs` 的 `TRAFFIC_CASE_REPORT.layout` 與 `columnMap` 裡。
 *
 * **為什麼不讀範本檔**（使用者 2026-09-01 決定）：這個格式是固定的，記在程式裡就不必
 * 帶著一個檔案跑——可攜版少複製一個檔，範本被人移走或不小心改壞也不影響產出。
 * 來文改版時改設定即可。
 *
 * ⚠ 產出檔含姓名與身分證字號，落在 `out/internal/`（不能發給分隊的那一層，見 config）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { estimateLineCount, rowHeightForLines } from './cellFit.mjs';
import { PATHS, TRAFFIC_CASE_REPORT } from './config.mjs';
import { monthlyFileName } from './fileNames.mjs';
import { log } from './logger.mjs';

/** 四邊都有框線。 */
function allBorders(style) {
  return { top: { style }, left: { style }, bottom: { style }, right: { style } };
}

/** 標題列（第 1 列）：跨整個表格寬度合併，置中。 */
function writeTitleRow(sheet, layout, columnCount) {
  const row = sheet.getRow(1);
  row.height = layout.titleRowHeight;
  const cell = row.getCell(1);
  cell.value = layout.title;
  cell.font = { name: layout.fontName, size: layout.titleFontSize };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.mergeCells(1, 1, 1, columnCount);
  row.commit();
}

/**
 * 欄位標題列（第 2 列）。
 *
 * 列高也要估：「醫護人員／檢傷分級」兩行 12 號字需要 34 點，範本只給 33.6，
 * Excel 會切到下緣一點點（2026-10-05 用 Excel 自動列高對照出來的）。
 */
function writeHeaderRow(sheet, layout, columnMap) {
  const row = sheet.getRow(2);
  const headerLines = Math.max(...columnMap.map((column) => (column.headerText ?? column.title).split('\n').length));
  row.height = rowHeightForLines(headerLines, layout.headerFontSize, layout.autoFit, layout.headerRowHeight);
  columnMap.forEach((column, index) => {
    const cell = row.getCell(index + 1);
    // 來文上有的格子是分兩行寫的（例：醫護人員／檢傷分級），照它的寫法。
    const headerText = column.headerText ?? column.title;
    cell.value = headerText;
    cell.font = { name: layout.fontName, size: layout.headerFontSize };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: headerText.includes('\n') };
    cell.border = allBorders(layout.borderStyle);
  });
  row.commit();
}

/**
 * 一列資料要多高才不會切到字：取所有換行欄裡最多的行數來算，不低於範本列高。
 *
 * @param {string[]} values 這一列各欄的文字
 * @returns {number} 列高（點）
 */
export function dataRowHeightFor(values) {
  const { layout, columnMap } = TRAFFIC_CASE_REPORT;
  const lineCount = values.reduce((most, text, columnIndex) => {
    const column = columnMap[columnIndex];
    if (column?.fit !== 'wrap') return most;
    return Math.max(most, estimateLineCount(text, column.width, layout.dataFontSize, layout.autoFit));
  }, 1);
  return rowHeightForLines(lineCount, layout.dataFontSize, layout.autoFit, layout.dataRowHeight);
}

/**
 * 資料格的對齊方式。
 *
 * 換行欄（地點、姓名）放不下就換行，整列會依 `dataRowHeightFor` 加高；
 * 其餘欄（日期、身分證字號…）只該有一行——開換行的話 `115/09/01` 會在斜線處被折成兩行、
 * 第二行被切掉，所以改成不換行、放不下時讓 Excel 縮小字型。
 */
function dataCellAlignment(column) {
  const wrap = column.fit === 'wrap';
  return {
    // 地點是唯一會長到換行的欄位，靠左看得比較順（設定在 columnMap 的 align）。
    horizontal: column.align ?? 'center',
    vertical: 'middle',
    wrapText: wrap,
    shrinkToFit: !wrap,
  };
}

/** 資料列：一列一件案子，從第 3 列開始。 */
function writeDataRows(sheet, layout, columnMap, rows) {
  rows.forEach((values, rowIndex) => {
    const row = sheet.getRow(3 + rowIndex);
    row.height = dataRowHeightFor(values);
    values.forEach((text, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = text;
      cell.font = { name: layout.fontName, size: layout.dataFontSize };
      cell.alignment = dataCellAlignment(columnMap[columnIndex]);
      cell.border = allBorders(layout.borderStyle);
    });
    row.commit();
  });
}

/**
 * 依設定的版面排出整張表。
 *
 * 不碰檔案系統，方便單獨測試版面有沒有跑掉。
 *
 * @param {import('./trafficCases.mjs').DocumentTable} table
 * @returns {import('exceljs').Workbook}
 */
export function createReportWorkbook(table) {
  const { layout, columnMap } = TRAFFIC_CASE_REPORT;
  if (table.headers.length !== columnMap.length) {
    throw new Error(
      `欄位數對不上：資料有 ${table.headers.length} 欄、來文格式有 ${columnMap.length} 欄。` +
        '兩者都來自 config 的 columnMap，對不上代表程式有誤。',
    );
  }

  const workbook = new ExcelJS.Workbook();
  // ⚠ 兩個檢視設定一定要寫：少了它們，Excel 會把**每一列的列高都縮成約三分之二**
  // （設 33.6 讀成 22.4），整張表的字都被切掉——2026-10-05 實測，改用範本以外的方式產檔後才出現。
  workbook.views = [{ x: 0, y: 0, width: 21900, height: 11916, firstSheet: 0, activeTab: 0, visibility: 'visible' }];
  const sheet = workbook.addWorksheet(layout.sheetName, {
    views: [{ state: 'normal', zoomScale: 100, zoomScaleNormal: 100 }],
    pageSetup: {
      paperSize: layout.print.paperSize,
      orientation: layout.print.orientation,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: layout.print.repeatRows,
    },
  });
  sheet.columns = columnMap.map((column) => ({ width: column.width }));

  writeTitleRow(sheet, layout, columnMap.length);
  writeHeaderRow(sheet, layout, columnMap);
  writeDataRows(sheet, layout, columnMap, table.rows);
  return workbook;
}

/**
 * 產出來文格式的 Excel。
 *
 * @param {import('./trafficCases.mjs').DocumentTable} table
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string>} 產出檔路徑
 */
export async function writeTrafficCaseReport(table, monthRange) {
  const workbook = createReportWorkbook(table);

  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(
    PATHS.internalDir,
    monthlyFileName(monthRange, TRAFFIC_CASE_REPORT.fileNamePrefix, 'xlsx'),
  );
  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (error) {
    // Excel 開著同一個檔案時會鎖住它，Node 只會拋出 EBUSY／EPERM 這種看不懂的訊息。
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(
        `產出檔正被其他程式開啟（通常是 Excel），無法覆寫：${filePath}\n` +
          '請關閉該檔案後重新執行；查詢結果不需要重跑，只差寫檔這一步。',
      );
    }
    throw error;
  }

  log.ok(`來文格式已產出：${path.relative(process.cwd(), filePath)}（共 ${table.rows.length} 件）`);
  return filePath;
}
