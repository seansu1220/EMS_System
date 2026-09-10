/**
 * 到院前預警的**未預警逐案清冊**——送醫了、但系統裡沒有到院前預警的每一件。
 *
 * 為什麼要有這一份（比照心電圖的逐案判定表，見 `ekgLedger.mjs` 檔頭）：
 * 報表上只看得到「山腳分隊 100/119」，分隊來問「那 19 件是哪 19 件」時，
 * 原本一件也答不出來——原始匯出檔含個資，跑完就刪，`last-run.log` 又每次覆寫。
 * 結果就是每被問一次就要重新登入、重跑一次查詢。
 *
 * 這份清冊把「總案件 − 預警案件」的差集攤平成一件一列，並標出該件有沒有被扣除。
 * 它同時也是**增減試算表對帳的依據**（見 `adjustAudit.mjs`）：
 * 一件案子要能被扣除，前提就是它出現在這份清單裡。
 *
 * ⚠ 個資原則：含完整 TEMSIS 與案件日期，比照逐案判定表——
 *   檔案只落在 `out/internal/`（已 gitignore、不上雲），終端機與 log 仍只印末 4 碼。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PATHS, TEMSIS_COLUMN_CANDIDATES, UNLOCK } from './config.mjs';
import { monthlyFileName, legacyMonthlyFileName } from './fileNames.mjs';
import { resolveColumnByNames, rowsNotIn } from './aggregate.mjs';
import { buildListSheet } from './ekgLists.mjs';
import { AUDIT_COLUMNS } from './adjustAudit.mjs';
import { log } from './logger.mjs';

/** 檔名前綴與大標（改名時兩個一起改，並同步 `fileNames.mjs` 的產出檔名單）。 */
export const UNALERTED = { prefix: '到院前未預警清冊', heading: '到院前未預警清冊' };

/** 逐案清單的欄位順序即輸出順序。 */
const CASE_COLUMNS = ['分隊', '案件日期', 'TEMSIS', '已提報並扣除'];

/** 各分隊件數分頁的欄位。 */
const SUMMARY_COLUMNS = ['分隊', '未預警件數', '其中已扣除'];

/** 扣除狀態欄的兩種值。 */
const DEDUCTED = { yes: '是', no: '否' };

/**
 * @typedef {Object} AlertSource 一份匯出檔，以及它的分隊欄名
 * @property {string[]} headers
 * @property {Record<string, unknown>[]} rows
 * @property {string} squadColumn
 */

/**
 * @typedef {Object} UnalertedCase 一件送醫但沒有到院前預警的案件
 * @property {string} squad
 * @property {string} caseDate 案件日期原文；讀不到為空字串
 * @property {string} temsis
 * @property {boolean} deducted 有沒有被增減試算表扣掉
 */

/** 取一列的某一欄，去掉前後空白；沒有那一欄就回傳空字串。 */
const cell = (row, column) => (column ? String(row[column] ?? '').trim() : '');

/**
 * 找出匯出檔的 TEMSIS 欄。
 *
 * 找不到就丟錯而不是默默略過：TEMSIS 是唯一能把「總案件」與「預警案件」兩份
 * 匯出檔對起來的鍵，沒有它算出來的差集會是整份總案件，反而誤導人。
 *
 * @param {AlertSource} source
 * @returns {string}
 */
function resolveTemsisColumn(source) {
  const resolved = resolveColumnByNames(source.headers, TEMSIS_COLUMN_CANDIDATES);
  if (!resolved) {
    throw new Error(
      `匯出檔中找不到 TEMSIS 欄（試過：${TEMSIS_COLUMN_CANDIDATES.join('、')}），無法列出未預警案件。`
        + `實際欄名有：${source.headers.join('、')}。`
        + '請把正確欄名加進 config.mjs 的 TEMSIS_COLUMN_CANDIDATES。',
    );
  }
  return resolved.column;
}

/**
 * 取出一份匯出檔裡的全部 TEMSIS。
 *
 * 用途：增減試算表對帳要分辨「這件有預警」與「查無此案」，
 * 前者要拿**全部送醫案件**來比對，光有未預警清單分不出來。
 *
 * @param {AlertSource} source
 * @returns {Set<string>}
 */
export function collectTemsis(source) {
  const column = resolveTemsisColumn(source);
  const codes = new Set();
  for (const row of source.rows) {
    const temsis = cell(row, column);
    if (temsis) codes.add(temsis);
  }
  return codes;
}

/**
 * 算出「送醫但沒有到院前預警」的案件（純函式，不碰檔案）。
 *
 * ⚠ 這裡算的是**未扣除前**的差集：增減試算表的扣除只動報表上的分母，
 * 被扣掉的案件本身仍是「沒有預警」的案件，照樣要列出來——分隊要看的正是
 * 「我這個月有幾件沒預警、其中幾件已經扣掉了」。扣掉的以 `deducted` 標示。
 *
 * @param {AlertSource} total 總案件（送醫）那份匯出檔
 * @param {AlertSource} alert 到院前預警案件那份匯出檔
 * @returns {UnalertedCase[]} 依分隊、案件日期排序
 */
export function buildUnalertedCases(total, alert) {
  const totalTemsis = resolveTemsisColumn(total);
  const alertTemsis = resolveTemsisColumn(alert);
  const caseDateColumn = resolveColumnByNames(total.headers, UNLOCK.listColumns.caseDate)?.column ?? null;

  const missing = rowsNotIn(total.rows, totalTemsis, alert.rows, alertTemsis);
  const cases = missing.map((row) => ({
    squad: cell(row, total.squadColumn) || '(讀不到分隊)',
    caseDate: cell(row, caseDateColumn),
    temsis: cell(row, totalTemsis),
    deducted: false,
  }));

  return cases.sort(
    (left, right) => left.squad.localeCompare(right.squad, 'zh-Hant')
      || left.caseDate.localeCompare(right.caseDate),
  );
}

/**
 * 把未預警案件整理成「TEMSIS → 該案實際所屬分隊」（純函式）。
 *
 * 這就是對帳的名單：增減試算表上的一列查得到這裡，才算得上是合法的扣除。
 *
 * @param {UnalertedCase[]} cases
 * @returns {Map<string, string>}
 */
export function indexUnalertedSquads(cases) {
  return new Map(cases.map((item) => [item.temsis, item.squad]));
}

/**
 * 標記哪些案件被扣掉了（純函式，回傳新陣列，不改動輸入）。
 *
 * @param {UnalertedCase[]} cases
 * @param {Set<string>} deductedTemsis 對帳後**實際採計**的 TEMSIS
 * @returns {UnalertedCase[]}
 */
export function markDeducted(cases, deductedTemsis) {
  return cases.map((item) => ({ ...item, deducted: deductedTemsis.has(item.temsis) }));
}

/**
 * 依分隊彙總未預警件數（純函式）。
 *
 * 依件數由多到少排序：會打開這份檔案的人，第一個要找的就是件數最多的那幾隊。
 *
 * @param {UnalertedCase[]} cases
 * @returns {{squad: string, count: number, deducted: number}[]}
 */
export function summarizeUnalerted(cases) {
  const bySquad = new Map();
  for (const item of cases) {
    const entry = bySquad.get(item.squad) ?? { squad: item.squad, count: 0, deducted: 0 };
    entry.count += 1;
    if (item.deducted) entry.deducted += 1;
    bySquad.set(item.squad, entry);
  }
  return [...bySquad.values()].sort(
    (left, right) => right.count - left.count || left.squad.localeCompare(right.squad, 'zh-Hant'),
  );
}

/**
 * 組出清冊的活頁簿（不寫檔，供測試在記憶體中檢查版面）。
 *
 * 三個分頁的分工：
 *   1. `各分隊件數`　看得出哪一隊要盯
 *   2. `逐案清單`　　拿回系統叫案件用的明細
 *   3. `增減表對帳`　每一列扣除成不成立、為什麼（見 `adjustAudit.mjs`）
 *
 * @param {UnalertedCase[]} cases
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {unknown[][]} [auditRows] 對帳結果；沒有增減試算表時傳空陣列，該分頁就不建
 * @returns {ExcelJS.Workbook}
 */
export function buildUnalertedWorkbook(cases, monthRange, auditRows = []) {
  const workbook = new ExcelJS.Workbook();
  const title = `${monthRange.label}　${UNALERTED.heading}`;

  const summary = summarizeUnalerted(cases);
  const totalDeducted = summary.reduce((sum, item) => sum + item.deducted, 0);
  const summaryRows = [
    ['合計', cases.length, totalDeducted],
    ...summary.map((item) => [item.squad, item.count, item.deducted]),
  ];
  buildListSheet(workbook, '各分隊件數', title, SUMMARY_COLUMNS, summaryRows);

  const caseRows = cases.map((item) => [
    item.squad,
    item.caseDate || '(讀不到)',
    item.temsis,
    item.deducted ? DEDUCTED.yes : DEDUCTED.no,
  ]);
  buildListSheet(workbook, '逐案清單', title, CASE_COLUMNS, caseRows);

  if (auditRows.length > 0) {
    buildListSheet(
      workbook,
      '增減表對帳',
      `${monthRange.label}　增減試算表逐列對帳`,
      AUDIT_COLUMNS,
      auditRows,
      { wideColumns: ['說明', '扣除原因'] },
    );
  }
  return workbook;
}

/**
 * 寫出未預警逐案清冊。
 *
 * @param {UnalertedCase[]} cases 已標記過扣除狀態的案件
 * @param {unknown[][]} auditRows 增減試算表的逐列對帳結果
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string|null>} 檔案路徑；沒有任何內容可寫時回傳 null
 */
export async function writeUnalertedList(cases, auditRows, monthRange) {
  if (cases.length === 0 && auditRows.length === 0) {
    log.info('這個月每一件送醫案件都有到院前預警，也沒有要對帳的扣除，不產出未預警清冊。');
    return null;
  }

  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(PATHS.internalDir, monthlyFileName(monthRange, UNALERTED.prefix, 'xlsx'));
  // 重跑舊月份時，把 2026-09-05 之前的舊檔名那一份清掉，免得同一個月留下兩份。
  await fs.rm(
    path.join(PATHS.internalDir, legacyMonthlyFileName(monthRange, UNALERTED.prefix, 'xlsx')),
    { force: true },
  );

  const workbook = buildUnalertedWorkbook(cases, monthRange, auditRows);
  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (error) {
    // Excel 開著同一個檔案時會鎖住它，Node 只會拋出 EBUSY／EPERM 這種看不懂的訊息。
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(
        `未預警清冊正被其他程式開啟（通常是 Excel），無法覆寫：${filePath}\n`
          + '請關閉該檔案後重新執行；查詢結果不需要重跑，只差寫檔這一步。',
      );
    }
    throw error;
  }

  const deductedCount = cases.filter((item) => item.deducted).length;
  log.ok(
    `未預警逐案清冊已產出：${path.relative(process.cwd(), filePath)}`
      + `（${cases.length} 件，其中 ${deductedCount} 件已扣除）`,
  );
  log.info('之後有分隊來問「我那幾件沒預警的是哪幾件」，直接開這份就看得到，不必重跑。');
  log.warn('這份含全局每一件的完整 TEMSIS，**不要整份發給分隊**，所以沒有放在 out/report/。');
  return filePath;
}
