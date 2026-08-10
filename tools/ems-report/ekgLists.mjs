/**
 * 心電圖流程的**附帶清單**（正式報表之外，給人拿去追蹤用的）。
 *
 *   1. `心電圖待人工確認`　程式判定不出來的案件，等使用者自己看
 *   2. `有處置未勾選清冊`　有上傳心電圖、但急救處置漏勾的案件，**用來提醒同仁記得點處置**
 *   3. `有EKG處置無12導程清冊`　反過來的那一邊，只有診斷指令會產出（見 `ekgDiagnose.mjs`）
 *
 * 版面比照正式報表：標題與欄名兩列置中，欄寬**依實際內容**計算
 * （只看欄名的話，「案件日期」這種短欄名配上長日期就會被截掉）。
 *
 * ⚠ 個資原則：兩份清冊的 **TEMSIS 都完整顯示**（使用者 2026-08-06 決定）。
 *   兩份的用途都是「拿著它回系統把案件叫出來」——一份給各分隊核對漏勾的處置，
 *   一份給使用者自己判斷傳輸時間——遮成末 4 碼反而要先用日期與分隊查一輪再比對，
 *   而看得到這些案件的人本來就看得到完整編號。
 *
 *   其餘防線不變：這兩個檔案落在 `out/report/`（已 gitignore、不上雲），
 *   終端機畫面與 `last-run.log` 仍一律只印末 4 碼。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PATHS, REPORT_FORMAT, UNLOCK } from './config.mjs';
import { resolveColumnByNames } from './aggregate.mjs';
import { log } from './logger.mjs';
import { computeColumnWidths, widenToFitTitle } from './sheetLayout.mjs';

/** 標題列的樣式（兩份清單共用）。 */
const TITLE_FONT = { bold: true, size: 14 };

/** 把一整列的文字置中（使用者 2026-08-05 要求標題那兩列都要置中）。 */
function centerRow(row, columnCount) {
  for (let column = 1; column <= columnCount; column += 1) {
    row.getCell(column).alignment = { ...REPORT_FORMAT.alignment };
  }
}

/**
 * 建立一個清單分頁：標題列（跨欄合併、置中）＋ 欄名列（置中）＋ 資料列。
 *
 * @param {ExcelJS.Workbook} workbook
 * @param {string} sheetName 分頁名稱
 * @param {string} title 第一列的大標
 * @param {string[]} header 欄名
 * @param {unknown[][]} rows 資料列（與欄名同順序）
 * @param {{wideColumns?: string[]}} [options] 指定要放寬的欄（說明類長文字）
 * @returns {ExcelJS.Worksheet}
 */
function buildListSheet(workbook, sheetName, title, header, rows, options = {}) {
  const sheet = workbook.addWorksheet(sheetName);
  const columnCount = header.length;

  const titleRow = sheet.addRow([title]);
  sheet.mergeCells(1, 1, 1, Math.max(1, columnCount));
  titleRow.getCell(1).font = TITLE_FONT;
  centerRow(titleRow, columnCount);

  const headerRow = sheet.addRow(header);
  headerRow.font = { bold: true };
  centerRow(headerRow, columnCount);

  for (const row of rows) sheet.addRow(row);

  // 欄寬依欄名與所有內容計算；標題是合併的，放不下會被切掉，故另外補足總寬。
  const widths = widenToFitTitle(
    computeColumnWidths(header, rows, { wideColumns: options.wideColumns }),
    title,
    TITLE_FONT.size,
  );
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  return sheet;
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
const PENDING_COLUMNS = ['分隊', '案件日期', 'TEMSIS', '到院時間', '讀到的上傳時間', '判定', '說明'];

/**
 * 組出待人工確認清單的活頁簿（不寫檔）。與寫檔分開，讓測試能在記憶體中檢查版面，
 * 而不會動到使用者 out/report/ 底下的檔案。
 *
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} pending 已篩出「判定不出來」的案件
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {ExcelJS.Workbook}
 */
export function buildPendingWorkbook(pending, monthRange) {
  const rows = pending.map((item) => [
    item.squad,
    item.caseDate ?? '(讀不到)',
    item.temsis,
    item.arrival ?? '(讀不到)',
    item.upload ?? '(讀不到)',
    item.verdict,
    item.reason,
  ]);
  const workbook = new ExcelJS.Workbook();
  buildListSheet(
    workbook,
    '待人工確認',
    `${monthRange.label}　心電圖待人工確認清冊`,
    PENDING_COLUMNS,
    rows,
    { wideColumns: ['說明'] },
  );
  return workbook;
}

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

  const workbook = buildPendingWorkbook(pending, monthRange);
  await writeWorkbook(workbook, filePath, '請關閉該檔案後重新執行；查核結果已存進度檔，不需要重跑。');
  log.warn(`有 ${pending.length} 件判定不出來，已另外列出：${path.relative(process.cwd(), filePath)}`);
  log.info('這些案件不計入分子。請自行到系統核對後，決定要不要把它們算進去。');
  return filePath;
}

/**
 * 兩份差集清冊的檔名與用語。
 *
 * 大標與件數欄的稱呼跟檔名放在一起，改名時三個地方一定一起改，
 * 不會出現「檔名是新的、大標還是舊的」。大標刻意只寫用途，
 * 不寫成一長串條件說明（使用者 2026-08-05 指定）。
 */
const MISSING_PROCEDURE_LIST = {
  prefix: '心電圖-有處置未勾選清冊',
  heading: '有處置未勾選清冊',
  countLabel: '漏勾件數',
};

/**
 * 反過來那一邊：**有勾 EKG檢查、但心電圖欄不是 12 導程**。
 *
 * 只有診斷指令會產出。2026-08-10 加的：分隊來問「分母怎麼比我自己查的多」時，
 * 多出來的通常就是這一批——他們只用「心電圖＝12導程」查，而分母是聯集。
 * 舊版只印件數不列案件，答不出「多的是哪一件」，只能再登入一次重查。
 */
const EKG_ONLY_LIST = {
  prefix: '心電圖-有EKG處置無12導程清冊',
  heading: '有EKG處置無12導程清冊',
  countLabel: '件數',
};

/** 把清冊設定與月份組成這一份的大標。 */
const titleOf = (spec, monthRange) => `${monthRange.label}　${spec.heading}`;

/**
 * 組出一份「分頁一：各分隊件數／分頁二：逐案清單」的活頁簿（不寫檔）。
 *
 * 兩份差集清冊的版面完全相同，差別只在大標與件數欄怎麼稱呼，
 * 因此版面只寫一次，用途性的字眼由呼叫端傳進來。
 *
 * @param {Record<string, unknown>[]} rows 差集的資料列（取自某一份匯出檔）
 * @param {{headers: string[], squadColumn: string, temsisColumn: string}} columns
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {{heading: string, countLabel: string}} spec 這份清冊的用語（見上方兩個常數）
 * @returns {{workbook: ExcelJS.Workbook, squadCount: number}}
 */
function buildTallyWorkbook(rows, columns, monthRange, spec) {
  const title = titleOf(spec, monthRange);
  const caseDateColumn = resolveColumnByNames(columns.headers, UNLOCK.listColumns.caseDate);
  const workbook = new ExcelJS.Workbook();

  // ---- 分頁一：各分隊件數（要找誰、幾件，一眼看得到）----
  const tally = new Map();
  for (const row of rows) {
    const squad = String(row[columns.squadColumn] ?? '').trim() || '(讀不到分隊)';
    tally.set(squad, (tally.get(squad) ?? 0) + 1);
  }
  const summaryRows = [
    ['合計', rows.length],
    ...[...tally].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hant'),
    ),
  ];
  const summary = buildListSheet(
    workbook,
    '各分隊件數',
    title,
    ['分隊', spec.countLabel],
    summaryRows,
  );
  summary.getRow(3).font = { bold: true }; // 合計列

  // ---- 分頁二：逐案清單（拿去系統核對用）----
  // TEMSIS 完整顯示：這份要拿去跟分隊逐案核對，遮成末 4 碼反而不好對（使用者 2026-08-05 指示）。
  const detailRows = rows.map((row) => [
    String(row[columns.squadColumn] ?? '').trim(),
    caseDateColumn ? String(row[caseDateColumn.column] ?? '').trim() : '(讀不到)',
    String(row[columns.temsisColumn] ?? '').trim(),
  ]);
  buildListSheet(workbook, '逐案清單', title, ['分隊', '案件日期', 'TEMSIS'], detailRows);
  return { workbook, squadCount: tally.size };
}

/**
 * 寫出一份差集清冊；沒有案件時把上一輪留下的舊檔刪掉。
 *
 * 不刪的話，一份寫著上個月數字的舊清單會一直躺著，看起來像是這次的結果。
 *
 * @returns {Promise<{filePath: string|null, squadCount: number, removedStale: boolean}>}
 *   沒有案件時 `filePath` 為 null，`removedStale` 表示確實刪掉了一份舊檔
 */
async function writeTallyList(rows, columns, monthRange, spec) {
  const filePath = path.join(PATHS.reportDir, `${spec.prefix}-${monthRange.label}.xlsx`);
  if (rows.length === 0) {
    const removedStale = await fs.rm(filePath, { force: true }).then(() => true).catch(() => false);
    return { filePath: null, squadCount: 0, removedStale };
  }
  const { workbook, squadCount } = buildTallyWorkbook(rows, columns, monthRange, spec);
  await writeWorkbook(workbook, filePath, '請關閉該檔案後重新執行。');
  return { filePath, squadCount, removedStale: false };
}

/**
 * 這份清冊 2026-08-05 之前叫這個名字。改名後留著舊檔會讓人搞不清哪份才是新的，
 * 但那是使用者的檔案（可能已手動編輯過），因此只提醒、不代為刪除。
 */
const LEGACY_MISSING_PROCEDURE_PREFIX = '心電圖-有12導程沒勾EKG';

/** 提醒使用者：同一個月還留著舊檔名的那一份，可以自己刪掉。 */
async function noteLegacyFile(monthRange) {
  const legacyPath = path.join(
    PATHS.reportDir,
    `${LEGACY_MISSING_PROCEDURE_PREFIX}-${monthRange.label}.xlsx`,
  );
  const exists = await fs.access(legacyPath).then(() => true).catch(() => false);
  if (!exists) return;
  log.info(
    `這份清冊已改名為「${MISSING_PROCEDURE_LIST.prefix}」；`
      + `舊檔 ${path.basename(legacyPath)} 不會再更新，確認過內容後可自行刪除。`,
  );
}

/**
 * 組出「有處置未勾選清冊」的活頁簿（不寫檔）。
 *
 * 兩個分頁：先給一張各分隊件數（要提醒誰、提醒幾件，一眼就看得到），
 * 再附逐案清單供回系統核對。
 *
 * @param {Record<string, unknown>[]} rows 漏勾的資料列（取自 12 導程那份匯出檔）
 * @param {{headers: string[], squadColumn: string, temsisColumn: string}} columns
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {{workbook: ExcelJS.Workbook, squadCount: number}}
 */
export function buildMissingProcedureWorkbook(rows, columns, monthRange) {
  return buildTallyWorkbook(rows, columns, monthRange, MISSING_PROCEDURE_LIST);
}

/**
 * 組出「有EKG處置無12導程清冊」的活頁簿（不寫檔）。版面與上面那份完全相同。
 *
 * @param {Record<string, unknown>[]} rows 差集的資料列（取自 EKG檢查那份匯出檔）
 * @param {{headers: string[], squadColumn: string, temsisColumn: string}} columns
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {{workbook: ExcelJS.Workbook, squadCount: number}}
 */
export function buildEkgOnlyWorkbook(rows, columns, monthRange) {
  return buildTallyWorkbook(rows, columns, monthRange, EKG_ONLY_LIST);
}

/**
 * 寫出「有上傳 12 導程心電圖、但急救處置沒勾 EKG檢查」的清冊。
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
  const written = await writeTallyList(rows, columns, monthRange, MISSING_PROCEDURE_LIST);

  if (!written.filePath) {
    if (written.removedStale) log.info('這次沒有漏勾 EKG檢查的案件；先前留下的清冊已一併清掉。');
    log.ok('所有有 12 導程的案件都有勾「EKG檢查」，不需要提醒。');
    return null;
  }

  await noteLegacyFile(monthRange);
  log.warn(
    `有 ${rows.length} 件上傳了 12 導程、卻沒勾「EKG檢查」，涉及 ${written.squadCount} 個分隊`
      + `：${path.relative(process.cwd(), written.filePath)}`,
  );
  log.info('這是要拿去提醒同仁「記得點選急救處置」的清冊，第一個分頁就是各分隊件數。');
  return written.filePath;
}

/**
 * 寫出「**有勾 EKG檢查、但心電圖欄不是 12 導程**」的清冊（差集的另一邊）。
 *
 * 分母是聯集（有勾 EKG檢查「或」有 12 導程），所以它由兩塊組成：
 * 這一份，加上 {@link writeMissingProcedureList} 那一份。分隊只用其中一個條件
 * 自己查，算出來就會比報表少——少掉的正是這兩份裡的案件。
 *
 * 只有診斷指令會產出：正式流程不需要它，多產一份檔案只會讓人搞不清該看哪份。
 *
 * @param {Record<string, unknown>[]} rows 差集的資料列（取自 EKG檢查那份匯出檔）
 * @param {{headers: string[], squadColumn: string, temsisColumn: string}} columns
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string|null>} 檔案路徑；沒有案件時回傳 null（並清掉舊檔）
 */
export async function writeEkgOnlyList(rows, columns, monthRange) {
  const written = await writeTallyList(rows, columns, monthRange, EKG_ONLY_LIST);

  if (!written.filePath) {
    if (written.removedStale) log.info('這次沒有這類案件；先前留下的清冊已一併清掉。');
    log.ok('有勾「EKG檢查」的案件全都有 12 導程，分母不會因為這一邊而變多。');
    return null;
  }

  log.warn(
    `有 ${rows.length} 件勾了「EKG檢查」、卻沒有 12 導程心電圖，涉及 ${written.squadCount} 個分隊`
      + `：${path.relative(process.cwd(), written.filePath)}`,
  );
  log.info('分隊若只用「心電圖＝12導程」自己查，少掉的就是這一批。');
  return written.filePath;
}
