/**
 * 心電圖流程的兩份**附帶清單**（正式報表之外，給人拿去追蹤用的）。
 *
 *   1. `待人工確認`　　　程式判定不出來的案件，等使用者自己看
 *   2. `有12導程沒勾EKG`　有上傳心電圖、但急救處置漏勾的案件，**用來提醒同仁記得點處置**
 *
 * 兩份都放在 `out/report/`，與正式報表同一層。該層的既定規範是
 * 「內容可以安全帶著走」，因此：
 *
 * ⚠ **TEMSIS 一律只寫末 4 碼**。分隊＋案件日期＋末 4 碼三者合起來，
 *   已足以在系統裡把案件找回來（先用日期與分隊查，再核對末 4 碼），
 *   沒有必要把完整編號寫進一份會被轉寄的檔案。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, UNLOCK } from './config.mjs';
import { resolveColumnByNames } from './aggregate.mjs';
import { log } from './logger.mjs';
import { maskCode } from './sheetFields.mjs';

/** 標題列的樣式（兩份清單共用）。 */
const TITLE_FONT = { bold: true, size: 14 };

/** 建立活頁簿並套上標題列；回傳 ExcelJS 的 workbook 與第一個分頁。 */
async function newListSheet(sheetName, title, columnCount) {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow([title]);
  sheet.mergeCells(1, 1, 1, Math.max(1, columnCount));
  sheet.getRow(1).font = TITLE_FONT;
  return { workbook, sheet };
}

/** 依標題文字給每一欄一個夠用的寬度；`說明`這種長欄位另外放寬。 */
function applyColumnWidths(sheet, header, wide = []) {
  header.forEach((name, index) => {
    sheet.getColumn(index + 1).width = wide.includes(name)
      ? 60
      : Math.max(14, name.length * 2 + 4);
  });
}

/**
 * 寫檔，並把「檔案正被 Excel 開著」翻成看得懂的話。
 * @returns {Promise<string>} 檔案路徑
 */
async function writeWorkbook(workbook, filePath, hint) {
  await fs.mkdir(PATHS.reportDir, { recursive: true });
  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(`${path.basename(filePath)} 正被其他程式開啟（通常是 Excel），無法覆寫。\n${hint}`);
    }
    throw error;
  }
  return filePath;
}

/** 待人工確認清單的欄位（順序即輸出順序）。 */
const PENDING_COLUMNS = ['分隊', '案件日期', 'TEMSIS末4碼', '到院時間', '讀到的上傳時間', '判定', '說明'];

/**
 * 把「判定不出來」的案件另外列成一份清單。
 *
 * 使用者 2026-08-03 決定：這些案件先不計入分子，改由他自己人工判定。
 * **這次沒有待確認案件時，會把上一輪留下的舊檔刪掉**——不刪的話，
 * 一份寫著「5 件判定不出來」的舊清單會一直躺著，看起來像是這次的結果。
 *
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {string} unknownVerdict 代表「無法判定」的字串
 * @returns {Promise<string|null>} 檔案路徑；沒有待確認案件時回傳 null
 */
export async function writePendingList(outcomes, monthRange, unknownVerdict) {
  const filePath = path.join(PATHS.reportDir, `心電圖待人工確認-${monthRange.label}.xlsx`);
  const pending = outcomes.filter((item) => item.verdict === unknownVerdict);
  if (pending.length === 0) {
    const removed = await fs.rm(filePath, { force: true }).then(() => true).catch(() => false);
    if (removed) log.info('這次沒有判定不出來的案件；先前留下的待人工確認清單已一併清掉。');
    return null;
  }

  const { workbook, sheet } = await newListSheet(
    '待人工確認',
    `${monthRange.label} 12導程心電圖：程式判定不出來、需要你自己看的案件`,
    PENDING_COLUMNS.length,
  );
  sheet.addRow(PENDING_COLUMNS).font = { bold: true };
  for (const item of pending) {
    sheet.addRow([
      item.squad,
      item.caseDate ?? '(讀不到)',
      maskCode(item.temsis),
      item.arrival ?? '(讀不到)',
      item.upload ?? '(讀不到)',
      item.verdict,
      item.reason,
    ]);
  }
  applyColumnWidths(sheet, PENDING_COLUMNS, ['說明']);

  await writeWorkbook(workbook, filePath, '請關閉該檔案後重新執行；查核結果已存進度檔，不需要重跑。');
  log.warn(`有 ${pending.length} 件判定不出來，已另外列出：${path.relative(process.cwd(), filePath)}`);
  log.info('這些案件不計入分子。請自行到系統核對後，決定要不要把它們算進去。');
  return filePath;
}

/**
 * 寫出「有上傳 12 導程心電圖、但急救處置沒勾 EKG檢查」的清單。
 *
 * 使用者 2026-08-05 要求把它併進正式流程，**用途是提醒同仁記得點處置**。
 * 成因已查明（見 TOOLS_SPEC 3.13）：ZOLL 監視器會自動把心電圖上傳，
 * 但不會自動把急救處置的「EKG檢查」勾起來，那要人手動勾。
 *
 * 因為用途是「提醒各分隊」，所以做**兩個分頁**：
 * 先給一張各分隊件數（要提醒誰、提醒幾件，一眼就看得到），再附逐案清單供核對。
 *
 * @param {Record<string, unknown>[]} rows 漏勾的資料列（取自 12 導程那份匯出檔）
 * @param {{headers: string[], squadColumn: string, temsisColumn: string}} columns
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string|null>} 檔案路徑；沒有漏勾案件時回傳 null（並清掉舊檔）
 */
export async function writeMissingProcedureList(rows, columns, monthRange) {
  const filePath = path.join(PATHS.reportDir, `心電圖-有12導程沒勾EKG-${monthRange.label}.xlsx`);
  if (rows.length === 0) {
    const removed = await fs.rm(filePath, { force: true }).then(() => true).catch(() => false);
    if (removed) log.info('這次沒有漏勾 EKG檢查的案件；先前留下的清單已一併清掉。');
    log.ok('所有有 12 導程的案件都有勾「EKG檢查」，不需要提醒。');
    return null;
  }

  const caseDateColumn = resolveColumnByNames(columns.headers, UNLOCK.listColumns.caseDate);
  const title = `${monthRange.label}　有上傳 12 導程心電圖、但急救處置沒有勾「EKG檢查」的案件`;

  // ---- 分頁一：各分隊件數（要提醒誰、幾件，一眼看得到）----
  const tally = new Map();
  for (const row of rows) {
    const squad = String(row[columns.squadColumn] ?? '').trim() || '(讀不到分隊)';
    tally.set(squad, (tally.get(squad) ?? 0) + 1);
  }
  const summaryHeader = ['分隊', '漏勾件數'];
  const { workbook, sheet: summary } = await newListSheet('各分隊件數', title, summaryHeader.length);
  summary.addRow(summaryHeader).font = { bold: true };
  summary.addRow(['合計', rows.length]).font = { bold: true };
  for (const [squad, count] of [...tally].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hant'),
  )) {
    summary.addRow([squad, count]);
  }
  applyColumnWidths(summary, summaryHeader);

  // ---- 分頁二：逐案清單（拿去系統核對用）----
  const detailHeader = ['分隊', '案件日期', 'TEMSIS末4碼'];
  const detail = workbook.addWorksheet('逐案清單');
  detail.addRow([title]);
  detail.mergeCells(1, 1, 1, detailHeader.length);
  detail.getRow(1).font = TITLE_FONT;
  detail.addRow(detailHeader).font = { bold: true };
  for (const row of rows) {
    detail.addRow([
      String(row[columns.squadColumn] ?? '').trim(),
      caseDateColumn ? String(row[caseDateColumn.column] ?? '').trim() : '(讀不到)',
      maskCode(String(row[columns.temsisColumn] ?? '').trim()),
    ]);
  }
  applyColumnWidths(detail, detailHeader);

  await writeWorkbook(workbook, filePath, '請關閉該檔案後重新執行。');
  log.warn(
    `有 ${rows.length} 件上傳了 12 導程、卻沒勾「EKG檢查」，涉及 ${tally.size} 個分隊`
      + `：${path.relative(process.cwd(), filePath)}`,
  );
  log.info('這是要拿去提醒同仁「記得點選急救處置」的清單，第一個分頁就是各分隊件數。');
  return filePath;
}
