/**
 * 未結案案件統整（第 9 章）的**產出**：終端機摘要與 Excel 報表。
 *
 * 報表四個分頁：
 *   1. 摘要：查詢期間、各階段筆數、**連一張已結案都沒有的案件數**（使用者最後要的那個數字）
 *   2. 案件統整：一件一列，`已結案*1+已填寫*2+未填寫*1`，沒有已結案的那幾列塗淺黃
 *   3. 各張紀錄表：案件內部讀到的每一列（項次／日期／車輛／分隊／狀態），供回頭核對統整
 *   4. 讀取失敗：查不到案號、進不了案件的，逐筆寫原因（沒有失敗就不建這一頁）
 *
 * ⚠ 個資：含完整 TEMSIS 與派遣案號（回系統查案件非用不可），因此只落在 `out/internal/`，
 *   不含病患姓名等欄位；終端機一律只印末 4 碼。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { OPEN_CASES, PATHS } from './config.mjs';
import { buildListSheet } from './ekgLists.mjs';
import { log } from './logger.mjs';
import { countSummaries } from './openCases.mjs';
import { maskCode } from './sheetFields.mjs';

/** 各分頁的欄位（順序即輸出順序）。 */
export const CASE_COLUMNS = [
  '案件日期', '派遣案號', '派遣分隊', '紀錄表張數', '救護表狀態統整', '有已結案', '未結案的紀錄表（TEMSIS）', '備註',
];
const RECORD_COLUMNS = ['派遣案號', '項次', '日期', '派遣車輛', '派遣分隊', '救護表狀態'];
const FAILURE_COLUMNS = ['卡在哪一步', 'TEMSIS／派遣案號', '分隊', '案件日期', '原因'];

/** 案件依日期排（日期相同再依案號），報表才好從頭看到尾。 */
function byCaseDate(left, right) {
  return left.caseDate.localeCompare(right.caseDate) || left.dispatchNo.localeCompare(right.dispatchNo);
}

/** 「有已結案」欄的寫法：讀取失敗的不知道答案，不寫有也不寫無。 */
function closedLabel(hasClosed) {
  if (hasClosed === null) return '讀取失敗';
  return hasClosed ? '有' : '無';
}

/**
 * 案件統整分頁的資料列（純函式）。
 * @param {import('./openCases.mjs').CaseSummary[]} summaries
 * @returns {unknown[][]}
 */
export function buildCaseRows(summaries) {
  return [...summaries].sort(byCaseDate).map((item) => [
    item.caseDate,
    item.dispatchNo,
    item.squads.join('、'),
    item.error ? '' : item.recordCount,
    item.error ? '' : item.statusText,
    closedLabel(item.hasClosed),
    item.openTemsis.join('\n'),
    [...item.notes, ...(item.error ? [item.error] : [])].join('；'),
  ]);
}

/**
 * 讀取失敗分頁的資料列（純函式）：查不到案號的紀錄表＋進不了的案件。
 * @param {import('./openCasesFlow.mjs').OpenCaseResult} result
 * @returns {unknown[][]}
 */
export function buildFailureRows(result) {
  const lookupFailures = result.lookups
    .filter((item) => item.error)
    .map((item) => ['讀指派案號', item.temsis, item.squad, item.caseDate, item.error]);
  const caseFailures = result.summaries
    .filter((item) => item.error)
    .map((item) => ['進案件內部', item.dispatchNo, item.squads.join('、'), item.caseDate, item.error]);
  return [...lookupFailures, ...caseFailures];
}

/**
 * 摘要分頁的資料列（純函式）。
 * @param {import('./openCasesFlow.mjs').OpenCaseResult} result
 * @param {import('./dateRange.mjs').MonthRange} range
 * @returns {unknown[][]}
 */
export function buildSummaryRows(result, range) {
  const counts = countSummaries(result.summaries);
  const lookupFailed = result.lookups.filter((item) => item.error).length;
  const rows = [
    ['查詢期間', `${range.start} ~ ${range.end}`],
    ['未結案的紀錄表', `${result.recordCount} 張`],
    ['讀到指派案號', `${result.lookups.length - lookupFailed} 張（讀不到 ${lookupFailed} 張）`],
    ['合併成案件', `${counts.caseCount} 件（成功統整 ${counts.inspected} 件、讀取失敗 ${counts.failed} 件）`],
    ['有已結案的案件', `${counts.withClosed} 件`],
    ['連一張已結案都沒有的案件', `${counts.withoutClosed} 件`],
  ];
  if (result.skipped > 0) rows.push(['⚠ 只跑了一部分', `依 --limit 少跑 ${result.skipped} 張紀錄表，數字不完整`]);
  if (result.aborted) rows.push(['⚠ 中途停止', '連續失敗太多筆而停下，數字不完整；12 小時內重跑會接著跑']);
  return rows;
}

/** 把「沒有已結案」的案件列塗上底色（在 `buildListSheet` 建好之後補）。 */
function highlightCasesWithoutClosed(sheet, rows) {
  const closedColumn = CASE_COLUMNS.indexOf('有已結案');
  rows.forEach((row, index) => {
    if (row[closedColumn] !== '無') return;
    // 前兩列是大標與欄名，資料從第 3 列開始。
    sheet.getRow(index + 3).eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: OPEN_CASES.highlightArgb } };
    });
  });
}

/**
 * 組出報表活頁簿（不寫檔，測試可以直接在記憶體裡檢查）。
 * @param {import('./openCasesFlow.mjs').OpenCaseResult} result
 * @param {import('./dateRange.mjs').MonthRange} range
 * @returns {ExcelJS.Workbook}
 */
export function buildOpenCaseWorkbook(result, range) {
  const workbook = new ExcelJS.Workbook();
  const period = `${range.start} ~ ${range.end}`;
  buildListSheet(workbook, '摘要', `未結案案件統整（${period}）`, ['項目', '內容'], buildSummaryRows(result, range));

  const caseRows = buildCaseRows(result.summaries);
  const caseSheet = buildListSheet(workbook, '案件統整', `案件統整（${period}）`, CASE_COLUMNS, caseRows, {
    wideColumns: ['備註'],
  });
  highlightCasesWithoutClosed(caseSheet, caseRows);
  // TEMSIS 一格可能好幾個（換行分隔），要開自動換行才看得到全部。
  caseSheet.getColumn(CASE_COLUMNS.indexOf('未結案的紀錄表（TEMSIS）') + 1).alignment = { wrapText: true, vertical: 'top' };
  caseSheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: CASE_COLUMNS.length } };

  const recordRows = [...result.summaries].sort(byCaseDate).flatMap((item) => item.records.map((record) => [
    item.dispatchNo, record.itemNo, record.date, record.vehicle, record.squad, record.status,
  ]));
  buildListSheet(workbook, '各張紀錄表', `案件內的每一張紀錄表（${period}）`, RECORD_COLUMNS, recordRows);

  const failureRows = buildFailureRows(result);
  if (failureRows.length > 0) {
    buildListSheet(workbook, '讀取失敗', `讀取失敗（${failureRows.length} 筆）`, FAILURE_COLUMNS, failureRows, {
      wideColumns: ['原因'],
    });
  }
  return workbook;
}

/**
 * 寫出報表。
 * @returns {Promise<string>} 檔案路徑
 */
export async function writeOpenCaseReport(result, range) {
  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(PATHS.internalDir, `${range.label}-${OPEN_CASES.reportName}.xlsx`);
  try {
    await buildOpenCaseWorkbook(result, range).xlsx.writeFile(filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(`${path.basename(filePath)} 正被其他程式開啟（通常是 Excel），無法覆寫。請關閉後重新執行。`);
    }
    throw error;
  }
  log.ok(`報表已產出：${path.relative(process.cwd(), filePath)}`);
  return filePath;
}

/**
 * 終端機摘要：每一件一行，最後是使用者要的那個數字。
 * @param {import('./openCasesFlow.mjs').OpenCaseResult} result
 */
export function printOpenCaseSummary(result) {
  log.step('案件統整');
  for (const item of [...result.summaries].sort(byCaseDate)) {
    const head = `${item.caseDate || '日期不明'}　${maskCode(item.dispatchNo)}　${item.squads.join('、') || '分隊不明'}`;
    if (item.error) log.warn(`${head}　讀取失敗：${item.error}`);
    else if (item.hasClosed) log.info(`${head}　${item.recordCount} 張：${item.statusText}`);
    else log.warn(`${head}　${item.recordCount} 張：${item.statusText}　← 沒有已結案`);
  }

  const counts = countSummaries(result.summaries);
  const lookupFailed = result.lookups.filter((item) => item.error).length;
  log.step('執行結果');
  log.info(`未結案紀錄表 ${result.recordCount} 張，合併成 ${counts.caseCount} 件案子`);
  log.ok(`連一張已結案都沒有的案件：${counts.withoutClosed} 件（有已結案的 ${counts.withClosed} 件）`);
  if (lookupFailed > 0 || counts.failed > 0) {
    log.warn(`讀不到案號 ${lookupFailed} 張、進不了案件 ${counts.failed} 件，不在上面的數字裡（明細見報表「讀取失敗」分頁）`);
  }
  if (result.skipped > 0) log.warn(`依 --limit 少跑了 ${result.skipped} 張，上面的數字不完整`);
  if (result.aborted) log.warn('中途因連續失敗停下，上面的數字不完整；12 小時內重跑會接著跑');
}
