/**
 * 二級以上因交通事故救護案件——把整理好的列填進「來文格式」範本並存檔。
 *
 * 為什麼是填範本而不是自己畫一張：來文格式是上級發文的固定版面（標題、欄位、欄寬），
 * 自己畫遲早會與來文長得不一樣。範本只有標題與欄位列、沒有任何個案資料，可以進版控。
 *
 * ⚠ 產出檔含姓名與身分證字號，落在 `out/internal/`（不能發給分隊的那一層，見 config）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PATHS, TRAFFIC_CASE_REPORT } from './config.mjs';
import { log } from './logger.mjs';

/** 標題比對用：去掉所有空白再比（範本的欄位標題含換行，例如「醫護人員\n檢傷分級」）。 */
function normalizeHeader(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/** 取得儲存格的純文字（ExcelJS 的值可能是物件形式的 rich text）。 */
function cellText(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join('');
  }
  return String(value);
}

/**
 * 在範本裡找出欄位標題列，並算出每一個來文欄位在第幾欄。
 *
 * 不寫死「標題在第 2 列、編號在 A 欄」：來文格式若多加一行說明或調整欄序，
 * 寫死的位置會安靜地把資料填到錯的地方。
 *
 * @param {import('exceljs').Worksheet} sheet
 * @param {string[]} wantedHeaders 來文欄位標題（依設定順序）
 * @param {string} templateFile 範本位置（只用在錯誤訊息，讓人知道要去改哪個檔）
 * @returns {{headerRowNumber: number, columnNumbers: number[]}}
 */
function locateHeaderRow(sheet, wantedHeaders, templateFile) {
  const firstCellText = normalizeHeader(TRAFFIC_CASE_REPORT.templateHeaderFirstCell);
  const searchLimit = Math.min(sheet.rowCount || 20, 20);

  for (let rowNumber = 1; rowNumber <= searchLimit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const texts = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      texts[columnNumber] = normalizeHeader(cellText(cell));
    });
    if (!texts.includes(firstCellText)) continue;

    const columnNumbers = wantedHeaders.map((header) => texts.indexOf(normalizeHeader(header)));
    const missing = wantedHeaders.filter((header, index) => columnNumbers[index] < 0);
    if (missing.length > 0) {
      throw new Error(
        `來文格式範本的第 ${rowNumber} 列找不到欄位：${missing.join('、')}。` +
          `範本上實際的欄位是：${texts.filter(Boolean).join('、')}`,
      );
    }
    return { headerRowNumber: rowNumber, columnNumbers };
  }
  throw new Error(
    `在來文格式範本的前 ${searchLimit} 列找不到欄位標題列` +
      `（預期有一格寫著「${TRAFFIC_CASE_REPORT.templateHeaderFirstCell}」）：` +
      templateFile,
  );
}

/**
 * 把一格填上值，並沿用標題列該欄的樣式（框線、字型、欄寬都跟著範本走）。
 * 標題是粗體、資料列不是，其餘照抄。
 */
function writeCell(cell, headerCell, text, alignLeft) {
  cell.value = text;
  cell.border = headerCell.border;
  cell.font = { ...headerCell.font, bold: false };
  cell.alignment = {
    vertical: 'middle',
    horizontal: alignLeft ? 'left' : 'center',
    wrapText: true,
  };
}

/**
 * 找出來文格式範本放在哪裡（完整安裝與可攜版的位置不同，見 config）。
 *
 * 兩個位置都沒有時把**找過的位置全部列出來**——只說「找不到範本」的話，
 * 使用者不會知道該把檔案放到哪裡去。
 *
 * @returns {Promise<string>}
 */
async function findTemplateFile() {
  for (const candidate of TRAFFIC_CASE_REPORT.templateFileCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 這個位置沒有，試下一個。
    }
  }
  throw new Error(
    '找不到來文格式範本（上級發文的空白格式，只有標題與欄位列）。找過這些位置：\n' +
      TRAFFIC_CASE_REPORT.templateFileCandidates.map((item) => `　${item}`).join('\n') +
      '\n請把「來文格式.xlsx」放到其中一個位置後重新執行。',
  );
}

/**
 * 產出來文格式的 Excel。
 *
 * @param {import('./trafficCases.mjs').DocumentTable} table
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string>} 產出檔路徑
 */
export async function writeTrafficCaseReport(table, monthRange) {
  const templateFile = await findTemplateFile();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templateFile);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`來文格式範本沒有任何工作表：${templateFile}`);

  const { headerRowNumber, columnNumbers } = locateHeaderRow(sheet, table.headers, templateFile);
  const headerRow = sheet.getRow(headerRowNumber);
  // 地點是唯一會長到換行的欄位，靠左看得比較順；其餘置中比照來文既有版面。
  const leftAlignedIndex = table.headers.indexOf('發生地點');

  table.rows.forEach((rowValues, index) => {
    const row = sheet.getRow(headerRowNumber + 1 + index);
    rowValues.forEach((text, columnIndex) => {
      const columnNumber = columnNumbers[columnIndex];
      writeCell(
        row.getCell(columnNumber),
        headerRow.getCell(columnNumber),
        text,
        columnIndex === leftAlignedIndex,
      );
    });
    row.height = headerRow.height ?? 22;
    row.commit();
  });

  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(
    PATHS.internalDir,
    `${TRAFFIC_CASE_REPORT.fileNamePrefix}-${monthRange.label}.xlsx`,
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
