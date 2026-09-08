/**
 * 到院前預警的**未預警逐案清冊**——送醫了、但系統裡沒有到院前預警的每一件。
 *
 * 為什麼要有這一份（比照心電圖的逐案判定表，見 `ekgLedger.mjs` 檔頭）：
 * 報表上只看得到「山腳分隊 100/119」，分隊來問「那 19 件是哪 19 件」時，
 * 原本一件也答不出來——原始匯出檔含個資，跑完就刪，`last-run.log` 又每次覆寫。
 * 結果就是每被問一次就要重新登入、重跑一次查詢。
 *
 * 這份清冊把「總案件 − 預警案件」的差集攤平成一件一列，並標出該件在增減試算表上
 * 有沒有被提報過，分隊要對數字時直接開檔案即可。
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
import { log } from './logger.mjs';

/** 檔名前綴與大標（改名時兩個一起改，並同步 `fileNames.mjs` 的產出檔名單）。 */
export const UNALERTED = { prefix: '到院前未預警清冊', heading: '到院前未預警清冊' };

/** 逐案清單的欄位順序即輸出順序。 */
const CASE_COLUMNS = ['分隊', '案件日期', 'TEMSIS', '已提報扣除'];

/** 各分隊件數分頁的欄位。 */
const SUMMARY_COLUMNS = ['分隊', '未預警件數', '其中已提報扣除'];

/** 提報狀態欄的兩種值（只是註記，不影響任何計算）。 */
const REPORTED = { yes: '是', no: '否' };

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
 * @property {boolean} reported 增減試算表上有沒有這一件
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
 * 算出「送醫但沒有到院前預警」的案件（純函式，不碰檔案）。
 *
 * ⚠ 這裡算的是**未扣除前**的差集：增減試算表的扣除只動報表上的分母，
 * 被扣掉的案件本身仍是「沒有預警」的案件，照樣要列出來——分隊要看的正是
 * 「我這個月有幾件沒預警、其中幾件已經提報過了」。已提報的以 `reported` 標示。
 *
 * @param {AlertSource} total 總案件（送醫）那份匯出檔
 * @param {AlertSource} alert 到院前預警案件那份匯出檔
 * @param {Set<string>} [reportedTemsis] 增減試算表上期間內填過的 TEMSIS
 * @returns {UnalertedCase[]} 依分隊、案件日期排序
 */
export function buildUnalertedCases(total, alert, reportedTemsis = new Set()) {
  const totalTemsis = resolveTemsisColumn(total);
  const alertTemsis = resolveTemsisColumn(alert);
  const caseDateColumn = resolveColumnByNames(total.headers, UNLOCK.listColumns.caseDate)?.column ?? null;

  const missing = rowsNotIn(total.rows, totalTemsis, alert.rows, alertTemsis);
  const cases = missing.map((row) => {
    const temsis = cell(row, totalTemsis);
    return {
      squad: cell(row, total.squadColumn) || '(讀不到分隊)',
      caseDate: cell(row, caseDateColumn),
      temsis,
      reported: reportedTemsis.has(temsis),
    };
  });

  return cases.sort(
    (left, right) => left.squad.localeCompare(right.squad, 'zh-Hant')
      || left.caseDate.localeCompare(right.caseDate),
  );
}

/**
 * 依分隊彙總未預警件數（純函式）。
 *
 * 依件數由多到少排序：會打開這份檔案的人，第一個要找的就是件數最多的那幾隊。
 *
 * @param {UnalertedCase[]} cases
 * @returns {{squad: string, count: number, reported: number}[]}
 */
export function summarizeUnalerted(cases) {
  const bySquad = new Map();
  for (const item of cases) {
    const entry = bySquad.get(item.squad) ?? { squad: item.squad, count: 0, reported: 0 };
    entry.count += 1;
    if (item.reported) entry.reported += 1;
    bySquad.set(item.squad, entry);
  }
  return [...bySquad.values()].sort(
    (left, right) => right.count - left.count || left.squad.localeCompare(right.squad, 'zh-Hant'),
  );
}

/**
 * 組出清冊的活頁簿（不寫檔，供測試在記憶體中檢查版面）。
 *
 * 兩個分頁的分工比照「有處置未勾選清冊」：
 * 第一頁看得到哪一隊要盯，第二頁才是拿回系統叫案件用的明細。
 *
 * @param {UnalertedCase[]} cases
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {ExcelJS.Workbook}
 */
export function buildUnalertedWorkbook(cases, monthRange) {
  const workbook = new ExcelJS.Workbook();
  const title = `${monthRange.label}　${UNALERTED.heading}`;

  const summary = summarizeUnalerted(cases);
  const totalReported = summary.reduce((sum, item) => sum + item.reported, 0);
  const summaryRows = [
    ['合計', cases.length, totalReported],
    ...summary.map((item) => [item.squad, item.count, item.reported]),
  ];
  buildListSheet(workbook, '各分隊件數', title, SUMMARY_COLUMNS, summaryRows);

  const caseRows = cases.map((item) => [
    item.squad,
    item.caseDate || '(讀不到)',
    item.temsis,
    item.reported ? REPORTED.yes : REPORTED.no,
  ]);
  buildListSheet(workbook, '逐案清單', title, CASE_COLUMNS, caseRows);
  return workbook;
}

/**
 * 寫出未預警逐案清冊。
 *
 * @param {AlertSource} total
 * @param {AlertSource} alert
 * @param {Set<string>} reportedTemsis
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<{filePath: string, cases: UnalertedCase[]}|null>} 一件都沒有時回傳 null
 */
export async function writeUnalertedList(total, alert, reportedTemsis, monthRange) {
  const cases = buildUnalertedCases(total, alert, reportedTemsis);
  if (cases.length === 0) {
    log.info('這個月每一件送醫案件都有到院前預警，不產出未預警清冊。');
    return null;
  }

  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(PATHS.internalDir, monthlyFileName(monthRange, UNALERTED.prefix, 'xlsx'));
  // 重跑舊月份時，把 2026-09-05 之前的舊檔名那一份清掉，免得同一個月留下兩份。
  await fs.rm(
    path.join(PATHS.internalDir, legacyMonthlyFileName(monthRange, UNALERTED.prefix, 'xlsx')),
    { force: true },
  );

  const workbook = buildUnalertedWorkbook(cases, monthRange);
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

  const reportedCount = cases.filter((item) => item.reported).length;
  log.ok(
    `未預警逐案清冊已產出：${path.relative(process.cwd(), filePath)}`
      + `（${cases.length} 件，其中 ${reportedCount} 件已提報扣除）`,
  );
  log.info('之後有分隊來問「我那幾件沒預警的是哪幾件」，直接開這份就看得到，不必重跑。');
  log.warn('⚠ 這份含全局每一件的完整 TEMSIS，**不要整份發給分隊**，所以沒有放在 out/report/。');
  return { filePath, cases };
}
