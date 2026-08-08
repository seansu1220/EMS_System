#!/usr/bin/env node
/**
 * 救護紀錄表查詢工具 CLI。
 *
 * 一般使用請雙擊專案的「捷徑\救護預警統計.bat」，不需要記這些指令。
 *
 * 用法：
 *   npm run tool:ems -- monthly              月度報表：預警比率 ＋ 心電圖傳輸率一次做完
 *   npm run tool:ems -- run                  只做到院前預警比率（預設查上個月）
 *   npm run tool:ems -- ekg                  只做 12 導程心電圖到院前傳輸率
 *   npm run tool:ems -- ekg --limit=5        只逐案查核前 5 件（先確認判斷正確再跑整月）
 *   npm run tool:ems -- ekg --no-verify      跳過逐案查核，只看原始件數（很快）
 *   npm run tool:ems -- <指令> --month=2026-06  指定月份
 *   npm run tool:ems -- <指令> --keep-raw    保留系統匯出的原始檔（含個資）
 *   npm run tool:ems -- probe                自動探測頁面結構（開發／改版時用）
 *   npm run tool:ems -- probe --manual       改為手動點選的探測模式
 *   npm run tool:ems -- check-sheet          檢查增減用的 Google 試算表能否讀取
 *   npm run tool:ems -- unlock               試跑：只找出該解哪一張，不會動到系統
 *   npm run tool:ems -- unlock --execute     真的按下「調整為未結案」
 *   npm run tool:ems -- unlock --temsis=A,B  直接指定 TEMSIS，不用互動輸入
 *   npm run tool:ems -- unlock-online        試跑：看網頁上有哪些待處理的解鎖工單
 *   npm run tool:ems -- unlock-online --execute  真的解鎖，並把結果回寫網頁
 *   npm run tool:ems -- unlock-watch         常駐監看：只維持登入不解鎖（可用來測登入能撐多久）
 *   npm run tool:ems -- unlock-watch --execute   常駐監看：有人送出申請就立刻處理
 *
 * 任何指令都可加 --fresh-login：捨棄上次保存的登入狀態，強制重新登入。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAutoProbe, runInteractiveProbe } from './probe.mjs';
import { startSession } from './session.mjs';
import { resolveMonthRange, getRecentRange } from './dateRange.mjs';
import { runUnlockFlow, promptTemsisList, printUnlockSummary } from './unlock.mjs';
import { runUnlockWatch } from './unlockWatch.mjs';
import {
  closeQueue,
  connectQueue,
  fetchPendingRequests,
  markRunning,
  saveResult,
} from './unlockQueue.mjs';
import { exportBothDatasets } from './scrape.mjs';
import { readTable, describeWorkbook } from './workbook.mjs';
import {
  resolveSquadColumn,
  resolveColumnByNames,
  countBySquad,
  countUnionBySquad,
  rowsNotIn,
  buildComparison,
  groupByBrigade,
  sortByRatioDesc,
  applyAdjustments,
} from './aggregate.mjs';
import { printReport, writeReport } from './report.mjs';
import { exportEkgDatasets } from './ekgScrape.mjs';
import { runEkgDiagnose } from './ekgDiagnose.mjs';
import {
  resolveEkgColumns,
  buildCaseList,
  verifyEkgCases,
  countVerifiedBySquad,
  progressFilePath,
  VERDICT,
} from './ekgVerify.mjs';
import { writePendingList, writeMissingProcedureList } from './ekgLists.mjs';
import {
  SQUAD_COLUMN_CANDIDATES,
  PATHS,
  BRIGADES,
  REPORT_FORMAT,
  REPORT_PROFILES,
  UNLOCK,
} from './config.mjs';
import {
  resolveSheetSource,
  fetchSheetRows,
  describeSheet,
  resolveAdjustColumns,
  countAdjustmentsBySquad,
} from './adjustSheet.mjs';
import { log, closePrompt, enableLiveLog, writeLogFile } from './logger.mjs';
import { maskCode } from './sheetFields.mjs';

/** 可用的指令。 */
const COMMANDS = [
  'run', 'ekg', 'ekg-diag', 'monthly', 'probe', 'check-sheet',
  'unlock', 'unlock-online', 'unlock-watch',
];

/**
 * @typedef {Object} CliOptions
 * @property {'probe'|'run'|'ekg'|'ekg-diag'|'monthly'|'check-sheet'|'unlock'|'unlock-online'
 *   |'unlock-watch'} command
 * @property {string|undefined} month
 * @property {boolean} keepRaw
 * @property {boolean} manual
 * @property {string[]} temsis
 * @property {boolean} dryRun
 * @property {boolean} freshLogin
 * @property {number|undefined} limit 心電圖逐案查核只跑前幾件
 * @property {boolean} verify 心電圖是否逐案查核上傳時間
 */

/** 解析 `--limit=N`；給了不是正整數的值就直接報錯，不默默忽略。 */
function parseLimit(args) {
  const raw = args.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--limit 必須是 1 以上的整數，收到：${raw}`);
  }
  return value;
}

/** 解析命令列參數。 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('--')) ?? 'run';
  if (!COMMANDS.includes(command)) {
    throw new Error(`未知的指令：${command}（可用：${COMMANDS.join('、')}）`);
  }
  const temsisArg = args.find((arg) => arg.startsWith('--temsis='))?.split('=')[1] ?? '';
  return {
    command,
    month: args.find((arg) => arg.startsWith('--month='))?.split('=')[1],
    keepRaw: args.includes('--keep-raw'),
    limit: parseLimit(args),
    /**
     * 心電圖的逐案查核很花時間（每件要開好幾個畫面）。
     * `--no-verify` 可以先看原始件數，確認查詢條件抓對了再跑完整流程。
     */
    verify: !args.includes('--no-verify'),
    /** probe 預設全自動；自動導航失敗時可用 --manual 改回手動點選。 */
    manual: args.includes('--manual'),
    temsis: temsisArg.split(/[\s,，;；]+/).filter(Boolean),
    /**
     * unlock **預設是試跑**（只定位不動手），要真的解鎖必須明確加 `--execute`。
     * 解鎖不可復原，預設值就該是安全的那一邊；`--dry-run` 寫不寫都一樣是試跑。
     */
    dryRun: !args.includes('--execute'),
    /** 保存的登入狀態怪怪的時候，用這個強制重新登入。 */
    freshLogin: args.includes('--fresh-login'),
  };
}

/**
 * 讀取一份匯出檔並依分隊計數。
 * 欄名屬於檔案結構（非個人資料），完整記錄下來，日後欄位變動時可直接對照。
 *
 * @returns {{table: import('./workbook.mjs').TableData, column: string, counts: Map<string, number>}}
 *   心電圖流程還要用同一份 `table` 取出 TEMSIS 與到院時間，故一併回傳，不重讀檔案。
 */
function countFile(filePath, label) {
  const table = readTable(filePath, SQUAD_COLUMN_CANDIDATES);
  log.info(`${label}：${table.rows.length} 筆、${table.headers.length} 欄`);

  const { column, reason } = resolveSquadColumn(table.headers, table.rows, SQUAD_COLUMN_CANDIDATES);
  const counts = countBySquad(table.rows, column);
  log.info(`  分隊欄位判定為「${column}」（${reason}），共 ${counts.size} 個分隊`);

  // 匯出檔有 200 多欄，全列會把紀錄檔灌爆；只有在判定沒把握時才列出完整欄名供排查。
  if (!reason.startsWith('內容')) {
    log.info(`  完整欄名：${table.headers.join(' ｜ ')}`);
  }

  // 全市分隊數量約 40 個，只算出 1~2 個幾乎必然是選錯欄位，早點擋下來免得產出錯誤報表。
  if (counts.size < 3 && table.rows.length > 100) {
    throw new Error(
      `分隊欄位判定可能有誤：${table.rows.length} 筆資料只分出 ${counts.size} 個分隊。` +
        `目前選中「${column}」。實際欄位有：${table.headers.join('、')}`,
    );
  }
  return { table, column, counts };
}

/** 刪除含個案明細的原始匯出檔。 */
async function removeRawFiles(rawFiles) {
  for (const filePath of Object.values(rawFiles)) {
    await fs.rm(filePath, { force: true });
  }
  log.ok('已刪除系統匯出的原始明細檔（只留下不含個資的統計報表）');
}

/** 匯出檔解析失敗時，印出「只有結構、沒有資料」的診斷資訊。 */
function reportParseFailure(rawFiles) {
  log.warn('原始匯出檔已保留，供比對格式使用（含個案明細，處理完請自行刪除）：');
  for (const [key, filePath] of Object.entries(rawFiles)) {
    log.info(`  ${key}：${filePath}`);
    try {
      const info = describeWorkbook(filePath);
      log.info(`    工作表=${info.sheetName} 列數=${info.rowCount} 欄數=${info.columnCount}`);
      log.info(`    第一列：${info.firstRowTexts.filter(Boolean).join(' | ')}`);
    } catch (error) {
      log.info(`    無法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 完整流程：查詢 → 匯出兩份 → 依分隊彙總 → 產出報表 → 刪除原始明細。
 * @param {import('./session.mjs').EmsSession} session
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {boolean} keepRaw
 */
async function runReportFlow(session, monthRange, keepRaw) {
  const rawFiles = await exportBothDatasets(session.context, session.page, monthRange);

  log.step('解析匯出檔並依分隊彙總');
  let stats;
  try {
    const totalCounts = countFile(rawFiles.total, '總案件').counts;
    const alertCounts = countFile(rawFiles.alert, '到院前預警案件').counts;
    stats = buildComparison(totalCounts, alertCounts);
  } catch (error) {
    log.fail('解析匯出檔', error);
    reportParseFailure(rawFiles);
    throw error;
  }

  stats = await adjustStats(stats, monthRange);

  if (stats.length === 0) {
    log.warn('查詢結果沒有任何案件，請確認查詢期間是否正確。');
  }

  const { rows: groupedRows, unmapped } = groupByBrigade(stats, BRIGADES, REPORT_FORMAT.unmappedGroupName);
  if (unmapped.length > 0) {
    log.warn(
      `有 ${unmapped.length} 個單位不在大隊對應表內，已歸入「${REPORT_FORMAT.unmappedGroupName}」：` +
        `${unmapped.join('、')}。若是新設或改隸分隊，請更新 config.mjs 的 BRIGADES。`,
    );
  }
  const sortedStats = sortByRatioDesc(stats);

  printReport(groupedRows, sortedStats, monthRange);
  await writeReport(groupedRows, sortedStats, monthRange);

  if (keepRaw) {
    log.warn(`依 --keep-raw 保留原始明細檔於 ${path.dirname(rawFiles.total)}（含個資，請自行妥善處理）`);
  } else {
    await removeRawFiles(rawFiles);
  }
}

/**
 * 分子必定是分母的子集合，超過就是**程式算錯了**。
 *
 * 分母是「有勾 EKG檢查 ∪ 有 12 導程」的聯集，分子是後者中查核通過的那些，
 * 因此數學上不可能超過。真的超過只有一個解釋：**聯集去重失敗**
 * （最可能是某份匯出檔的 TEMSIS 欄抓錯，導致同一件案子被算成兩件、或根本沒被納入分母）。
 *
 * 這種錯誤產出的報表看起來完全正常，不主動檢查就會一路錯下去。
 *
 * @param {Map<string, number>} denominatorCounts 聯集後的分母
 * @param {Map<string, number>} numeratorCounts 查核通過的分子
 */
function warnIfNumeratorExceedsDenominator(denominatorCounts, numeratorCounts) {
  const sum = (counts) => [...counts.values()].reduce((total, count) => total + count, 0);
  const denominatorTotal = sum(denominatorCounts);
  const numeratorTotal = sum(numeratorCounts);

  const broken = [...numeratorCounts]
    .filter(([squad, count]) => count > (denominatorCounts.get(squad) ?? 0))
    .map(([squad, count]) => `${squad}（${count}>${denominatorCounts.get(squad) ?? 0}）`);
  if (numeratorTotal <= denominatorTotal && broken.length === 0) return;

  log.warn('⚠⚠ 分子比分母還多，這在數學上不可能，報表數字不可採用 ⚠⚠');
  log.warn(`　全局：分子 ${numeratorTotal} 件 > 分母 ${denominatorTotal} 件`);
  if (broken.length > 0) {
    log.warn(`　分隊：${broken.slice(0, 10).join('、')}${broken.length > 10 ? ` 等 ${broken.length} 隊` : ''}`);
  }
  log.warn('　分子是分母的子集合，超過代表聯集去重失敗——最可能是某份匯出檔的 TEMSIS 欄抓錯。');
  log.warn('　請看上方「TEMSIS 欄判定為…」那兩行，確認兩份檔案都抓到正確的欄位。');
}

/**
 * 心電圖流程：兩次查詢與匯出 → 逐案查核 → 產出報表。
 *
 * 分母＝做過 EKG 檢查的案件；
 * 分子＝做了 12 導程、**且查核確認在到院前就傳出去**的案件。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {CliOptions} options
 */
async function runEkgFlow(session, monthRange, options) {
  const profile = REPORT_PROFILES.ekg;
  const rawFiles = await exportEkgDatasets(session.context, session.page, monthRange);

  log.step('解析匯出檔並依分隊彙總');
  const ekgChecked = countFile(rawFiles.denominator, '有勾EKG檢查的案件');
  const numerator = countFile(rawFiles.numerator, '有12導程心電圖的案件（分子母體，未查核）');

  // 分母＝兩者的**聯集**（使用者 2026-08-04 決定）：實測兩邊互有出入
  // （EKG檢查 243、12導程 285、交集只有 202），用任一邊當分母都會把另一邊
  // 獨有的案件排除在評比之外。分子是 12 導程的子集合，因此比率必定 ≤ 100%。
  const denominatorColumns = {
    ekg: resolveEkgColumns(ekgChecked.table, resolveColumnByNames),
    twelveLead: resolveEkgColumns(numerator.table, resolveColumnByNames),
  };
  const union = countUnionBySquad([
    { rows: ekgChecked.table.rows, temsisColumn: denominatorColumns.ekg.temsis, squadColumn: ekgChecked.column },
    { rows: numerator.table.rows, temsisColumn: denominatorColumns.twelveLead.temsis, squadColumn: numerator.column },
  ]);
  log.ok(
    `分母（聯集）：${union.total} 件`
      + `＝有勾EKG檢查 ${ekgChecked.table.rows.length} 件 ∪ 有12導程 ${numerator.table.rows.length} 件`,
  );
  if (union.conflicts.length > 0) {
    log.warn(
      `有 ${union.conflicts.length} 件案子在兩份匯出檔裡的分隊不一致，已以先出現的為準：`
        + union.conflicts.slice(0, 5).map(maskCode).join('、'),
    );
  }

  // 「有上傳 12 導程、卻沒勾 EKG檢查」的清單（使用者 2026-08-05 要求併入正式流程，
  // 用途是提醒同仁記得點處置）。兩份匯出檔都已經在手上，取差集不必再查一次系統。
  const missingProcedure = rowsNotIn(
    numerator.table.rows,
    denominatorColumns.twelveLead.temsis,
    ekgChecked.table.rows,
    denominatorColumns.ekg.temsis,
  );
  const missingProcedurePath = await writeMissingProcedureList(missingProcedure, {
    headers: numerator.table.headers,
    squadColumn: numerator.column,
    temsisColumn: denominatorColumns.twelveLead.temsis,
  }, monthRange);

  let verifiedCounts = numerator.counts;
  let pendingPath = null;
  /** 分子不完整的原因；非空字串代表這份數字不能當正式報表。 */
  let incomplete = '';
  if (options.verify) {
    const columns = denominatorColumns.twelveLead;
    for (const note of columns.notes) log.info(note);

    const cases = buildCaseList(numerator.table.rows, {
      temsis: columns.temsis,
      squad: numerator.column,
      arrival: columns.arrival,
    });
    log.info(`可逐案查核的案件：${cases.length} 件（匯出檔共 ${numerator.table.rows.length} 列）`);

    const result = await verifyEkgCases(session, cases, monthRange, { limit: options.limit });
    verifiedCounts = countVerifiedBySquad(result.outcomes);
    printVerifySummary(result.outcomes, cases.length);
    pendingPath = await writePendingList(result.outcomes, monthRange, VERDICT.unknown);
    if (result.aborted) {
      incomplete = '查核中途被中止（連續多件判定不出來）';
      log.warn('查核中途已中止，這份報表的分子並不完整，請修正問題後重跑（會接續進度）。');
    } else if (result.skipped > 0) {
      incomplete = `依 --limit 只查核了 ${result.outcomes.length} / ${cases.length} 件`;
    }
  } else {
    incomplete = '加了 --no-verify、沒有逐案查核';
    log.warn('依 --no-verify 跳過逐案查核：分子是「有做 12 導程」的原始件數，');
    log.warn('  **沒有**排除掉到院後才上傳的案件，數字會偏高，不可當成正式報表。');
  }

  const stats = buildComparison(union.counts, verifiedCounts);
  // 分子是分母的子集合，超過就代表聯集算錯了（例如 TEMSIS 欄抓錯而去重失敗）。
  warnIfNumeratorExceedsDenominator(union.counts, verifiedCounts);
  if (stats.length === 0) log.warn('查詢結果沒有任何案件，請確認查詢期間是否正確。');

  const { rows: groupedRows, unmapped } = groupByBrigade(stats, BRIGADES, REPORT_FORMAT.unmappedGroupName);
  if (unmapped.length > 0) {
    log.warn(
      `有 ${unmapped.length} 個單位不在大隊對應表內，已歸入「${REPORT_FORMAT.unmappedGroupName}」：`
        + `${unmapped.join('、')}。若是新設或改隸分隊，請更新 config.mjs 的 BRIGADES。`,
    );
  }

  const sortedStats = sortByRatioDesc(stats);
  printReport(groupedRows, sortedStats, monthRange, profile);
  // 分子不完整時**不寫檔**：一份每個分隊都是 0.0% 的 xlsx 看起來跟正式報表一模一樣，
  // 擺在 out/report/ 裡遲早會被誤當成真的寄出去。終端機上的表格照印，
  // 因為那正是拿來核對「欄位有沒有抓對」用的（2026-08-04 實跑後補上）。
  if (incomplete) {
    log.warn(`因為${incomplete}，這次**不會**寫出 ${profile.fileNamePrefix} 的 Excel 檔。`);
    log.info('上面的表格只能拿來核對欄位判定是否正確，數字不可當成正式結果。');
  } else {
    await writeReport(groupedRows, sortedStats, monthRange, profile);
  }
  log.step('這次產出的檔案');
  if (!incomplete) log.info(`　${profile.fileNamePrefix}-${monthRange.label}.xlsx（正式報表）`);
  if (missingProcedurePath) {
    log.info(`　${path.basename(missingProcedurePath)}（**提醒同仁記得點處置**用）`);
  }
  if (pendingPath) log.info(`　${path.basename(pendingPath)}（判定不出來，要你人工看）`);

  if (options.keepRaw) {
    log.warn(`依 --keep-raw 保留原始明細檔於 ${path.dirname(rawFiles.denominator)}（含個資，請自行妥善處理）`);
  } else {
    await removeRawFiles({
      denominator: rawFiles.denominator,
      numerator: rawFiles.numerator,
      // 進度檔含完整 TEMSIS，屬個案明細，跟匯出檔同一批處理掉。
      progress: progressFilePath(monthRange),
    });
  }
}

/** 逐案查核的結果摘要（只有件數，不列個案）。 */
function printVerifySummary(outcomes, totalCases) {
  const countOf = (verdict) => outcomes.filter((item) => item.verdict === verdict).length;
  log.step('逐案查核結果');
  log.info(`到院前傳出：${countOf(VERDICT.before)} 件（這些才計入分子）`);
  log.info(`到院後才傳：${countOf(VERDICT.after)} 件（不計入）`);
  log.info(`判定不出來：${countOf(VERDICT.unknown)} 件（不計入，另外列清單）`);
  if (outcomes.length < totalCases) {
    log.warn(`本次只查核了 ${outcomes.length} / ${totalCases} 件，其餘未查核的一律不計入分子。`);
  }
}

/**
 * 檢查增減用的 Google 試算表能不能讀到，並印出結構供核對欄位。
 * 不需要開瀏覽器，也不需要登入救護系統。
 */
async function checkAdjustSheet(monthRange) {
  const source = resolveSheetSource();
  if (!source) {
    log.warn('尚未設定 EMS_ADJUST_SHEET_URL（位於 tools/ems-report/.env）。');
    log.info('把 Google 試算表的整串網址貼在該參數後面存檔，再執行一次即可。');
    return;
  }
  log.info(
    `試算表 ID 長度 ${source.spreadsheetId.length}、分頁 ${source.gid ?? '（未指定，取第一個）'}（不顯示網址）`,
  );

  const rows = await fetchSheetRows(source);
  const info = describeSheet(rows);
  log.ok(`讀取成功：${info.rowCount} 列（含標題）、${info.columnCount} 欄`);
  log.info('各欄結構（只顯示欄名與型態推測，不顯示任何內容）：');
  for (const column of info.columns) {
    const kinds = column.kinds.length > 0 ? `｜推測：${column.kinds.join('＋')}` : '';
    log.info(`  [${column.index}] ${column.header || '(無標題)'} → ${column.filled} 筆有值、${column.distinct} 種${kinds}`);
  }

  const columns = resolveAdjustColumns(rows);
  log.ok(`日期欄判定為第 [${columns.dateColumn}] 欄、分隊欄判定為第 [${columns.squadColumn}] 欄`);

  const { counts, inRange, outOfRange, unparsable } = countAdjustmentsBySquad(rows, columns, monthRange);
  log.step(`試算：${monthRange.start} ~ ${monthRange.end} 期間內要扣除的件數`);
  log.info(`期間內 ${inRange} 件、期間外 ${outOfRange} 件、日期或分隊讀不出來 ${unparsable} 件`);
  // 使用者確認：試算表中日期空白屬正常情形，不需處理，故以一般訊息呈現而非警告，
  // 避免每次執行都跳警示而讓真正該注意的訊息被淹沒。
  if (unparsable > 0) {
    log.info(`（其中 ${unparsable} 列的日期或分隊為空白，無法判斷期間，未列入扣除）`);
  }
  for (const [squad, count] of [...counts].sort((left, right) => right[1] - left[1])) {
    log.info(`  ${squad}　-${count}`);
  }
  if (counts.size === 0) log.warn('這個期間沒有任何要扣除的案件。');
}

/** 讀取增減試算表並套用扣除；未設定或讀取失敗時不中斷主流程。 */
async function adjustStats(stats, monthRange) {
  const source = resolveSheetSource();
  if (!source) {
    log.info('未設定增減試算表（EMS_ADJUST_SHEET_URL），略過扣除。');
    return stats;
  }
  log.step('套用增減試算表的扣除');
  const rows = await fetchSheetRows(source);
  const columns = resolveAdjustColumns(rows);
  const { counts, inRange, outOfRange, unparsable } = countAdjustmentsBySquad(rows, columns, monthRange);
  log.info(`試算表 ${rows.length - 1} 列：期間內 ${inRange} 件、期間外 ${outOfRange} 件、無法判讀 ${unparsable} 件`);

  const result = applyAdjustments(stats, counts);
  log.ok(`已自送醫案件數（分母）扣除 ${result.applied} 件，預警案件數不變`);
  if (result.unmatched.length > 0) {
    log.warn(`試算表中有 ${result.unmatched.length} 個分隊在統計結果裡找不到，未扣除：${result.unmatched.join('、')}`);
  }
  if (result.overflow.length > 0) {
    log.warn(`以下分隊扣除後分母小於分子，請人工確認：${result.overflow.join('、')}`);
  }
  return result.stats;
}

/**
 * 開瀏覽器、登入，然後執行指定動作。
 * 失敗時把當下的 frame 狀態一併記進紀錄檔，方便判斷卡在哪一頁。
 * @param {(session: import('./session.mjs').EmsSession) => Promise<void>} action
 * @param {{ freshLogin?: boolean }} [sessionOptions]
 */
async function withSession(action, sessionOptions = {}) {
  const session = await startSession(sessionOptions);
  try {
    await action(session);
  } catch (error) {
    log.info('失敗當下的頁面狀態：');
    for (const frame of session.page.frames()) {
      log.info(`  frame ${frame.name() || '(主文件)'} → ${frame.url()}`);
    }
    throw error;
  } finally {
    await session.close();
    closePrompt();
    log.info('瀏覽器已關閉');
  }
}

/**
 * 解鎖救護紀錄表。
 *
 * ⚠ **預設是試跑**（只定位不動手）。要真的解鎖必須明確加 `--execute`：
 *   解鎖無法復原，預設值就該站在安全的那一邊。
 *   實際解鎖時也只有明確定位到目標的案件才會動手，其餘一律略過。
 */
async function runUnlockCommand(options) {
  const range = getRecentRange(UNLOCK.lookbackMonths);
  const temsisList = options.temsis.length > 0 ? options.temsis : await promptTemsisList();
  if (temsisList.length === 0) {
    log.warn('沒有輸入任何 TEMSIS，結束。');
    return;
  }
  await withSession(async (session) => {
    const outcomes = await runUnlockFlow(session, { temsisList, range, dryRun: options.dryRun });
    printUnlockSummary(outcomes, { dryRun: options.dryRun });
  }, { freshLogin: options.freshLogin });
}

/**
 * 線上解鎖工單：把網頁上待處理的申請跑完，結果回寫網頁。
 *
 * 與 `unlock` 的差別只在「TEMSIS 從哪來、結果往哪去」——
 * 中間實際解鎖的那一段是同一支 `runUnlockFlow`，沒有另一套邏輯。
 *
 * ⚠ **預設是試跑**：只列出有哪些待處理工單，不解鎖也不回寫，
 *   要真的做必須明確加 `--execute`（與 `unlock` 同一套安全預設）。
 *
 * 順序刻意是「先拿工單、再開瀏覽器」：沒有待處理工單時就不必白登入一次救護系統。
 */
async function runUnlockOnlineCommand(options) {
  const queue = await connectQueue();
  // Firebase 的連線會撐著 Node 的事件迴圈：不關的話事情都做完了、訊息也印完了，
  // 黑色視窗卻一直不會結束，看起來就像當掉（2026-08-06 實測踩到）。
  try {
    await processUnlockQueue(queue, options);
  } finally {
    await closeQueue(queue);
  }
}

/** 線上工單的實際內容（與雲端連線的開關由呼叫端負責）。 */
async function processUnlockQueue(queue, options) {
  const requests = await fetchPendingRequests(queue);
  if (requests.length === 0) {
    log.ok('目前沒有待處理的解鎖工單，不需要登入救護系統。');
    return;
  }

  log.step(`待處理的解鎖工單：${requests.length} 筆`);
  for (const [position, request] of requests.entries()) {
    log.info(
      `  ${position + 1}. ${maskCode(request.temsis)}　${request.requestedByName || '（未記錄申請人）'}`
        + `　${request.reason || '（沒填事由）'}`,
    );
  }

  if (options.dryRun) {
    log.warn('本次為試跑：沒有解鎖，也沒有回寫任何工單。');
    log.info('要真的處理請執行「捷徑\\線上解鎖工單.bat」（或加上 --execute）。');
    return;
  }

  const range = getRecentRange(UNLOCK.lookbackMonths);
  await withSession(async (session) => {
    const outcomes = await runUnlockFlow(session, {
      temsisList: requests.map((request) => request.temsis),
      range,
      dryRun: false,
      // 逐筆回寫，不等整批跑完：中途關掉視窗時，前面做完的幾筆在網頁上才不會停在「待處理」。
      onCaseStart: (_temsis, index) => markRunning(queue, requests[index].id),
      onCaseDone: (outcome, index) => saveResult(queue, requests[index].id, outcome),
    });
    printUnlockSummary(outcomes, { dryRun: false });
    log.info('以上結果已回寫網頁，申請人自己看得到，不需要另外通知。');
  }, { freshLogin: options.freshLogin });
}

/**
 * 常駐監看線上工單：登入一次之後就一直開著，有人送出申請就立刻處理。
 *
 * 與 `unlock-online` 的差別只有「不結束」。能一直不用重打驗證碼的關鍵是
 * **定期戳一下系統維持登入**（見 `unlockWatch.mjs`）；真的被踢掉時會停下來
 * 請本人再輸入一次，絕不自動辨識。
 *
 * ⚠ **預設是試跑**（只監看與維持登入、不解鎖），要真的處理必須加 `--execute`。
 *   試跑本身就是個有用的工具：放著跑就能看出登入到底能撐多久。
 */
async function runUnlockWatchCommand(options) {
  // 監看會跑很久，而且多半是被直接關掉視窗而結束——結束時才落檔等於沒有紀錄。
  // 改成邊跑邊寫，事後才查得出「半夜到底發生什麼事」。
  await enableLiveLog(PATHS.watchLogFile);
  log.info(`即時紀錄：${path.relative(process.cwd(), PATHS.watchLogFile)}（邊跑邊寫，關掉視窗也留得住）`);
  const queue = await connectQueue();
  /** 關掉視窗或按 Ctrl+C 時，讓迴圈跑完這一輪就收工。 */
  let stopping = false;
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    log.warn('收到結束指示，正在收尾（不會中斷正在處理的那一筆）…');
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  let session = null;
  try {
    session = await startSession({ freshLogin: options.freshLogin });
    // 解鎖流程要用的查詢期間；監看是長時間執行，掛在 session 上一起帶著走。
    session.range = getRecentRange(UNLOCK.lookbackMonths);
    await runUnlockWatch(session, queue, {
      dryRun: options.dryRun,
      shouldStop: () => stopping,
    });
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    await session?.close();
    await closeQueue(queue);
    closePrompt();
    log.info('瀏覽器已關閉');
  }
}

async function main() {
  const options = parseArgs(process.argv);
  log.step(`救護紀錄表查詢工具｜指令：${options.command}`);

  if (options.command === 'unlock') {
    await runUnlockCommand(options);
    return;
  }
  if (options.command === 'unlock-online') {
    await runUnlockOnlineCommand(options);
    return;
  }
  if (options.command === 'unlock-watch') {
    await runUnlockWatchCommand(options);
    return;
  }

  const monthRange = resolveMonthRange(options.month);
  if (options.command === 'check-sheet') {
    log.info(`試算期間：${monthRange.start} ~ ${monthRange.end}（${monthRange.label}）`);
    await checkAdjustSheet(monthRange);
    return;
  }

  log.info(`查詢期間：${monthRange.start} ~ ${monthRange.end}（${monthRange.label}）`);
  await withSession(async (session) => {
    if (options.command === 'probe') {
      await (options.manual
        ? runInteractiveProbe(session.context)
        : runAutoProbe(session.context, session.page));
      return;
    }
    if (options.command === 'ekg') {
      await runEkgFlow(session, monthRange, options);
      return;
    }
    if (options.command === 'ekg-diag') {
      await runEkgDiagnose(session, monthRange);
      return;
    }
    if (options.command === 'monthly') {
      await runMonthlyFlow(session, monthRange, options);
      return;
    }
    await runReportFlow(session, monthRange, options.keepRaw);
  }, { freshLogin: options.freshLogin });
}

/**
 * 月度報表：一次登入把兩份報表都做完。
 *
 * 兩份報表各自獨立輸出成一個檔（使用者 2026-08-03 選擇），既有的預警報表檔名與格式完全不變。
 *
 * **前面那份失敗不會讓後面那份也做不成**：兩份報表沒有依賴關係，
 * 心電圖流程要跑一兩個小時，不該因為預警報表的一個小問題就整晚白跑。
 * 失敗的那份會在最後統一報告，結束碼也會反映出來。
 */
async function runMonthlyFlow(session, monthRange, options) {
  /** @type {{name: string, error: unknown}[]} */
  const failures = [];
  const steps = [
    { name: '到院前預警比率', run: () => runReportFlow(session, monthRange, options.keepRaw) },
    { name: '12導程心電圖到院前傳輸率', run: () => runEkgFlow(session, monthRange, options) },
  ];

  for (const [position, step] of steps.entries()) {
    log.step(`月度報表 ${position + 1} / ${steps.length}：${step.name}`);
    try {
      await step.run();
      log.ok(`${step.name} 完成`);
    } catch (error) {
      failures.push({ name: step.name, error });
      log.fail(step.name, error);
      log.warn(`${step.name} 失敗，繼續做下一份報表（兩份互不相干）。`);
    }
  }

  log.step('月度報表輸出結果');
  for (const step of steps) {
    const failed = failures.find((item) => item.name === step.name);
    if (failed) log.warn(`${step.name}：失敗（${failed.error instanceof Error ? failed.error.message : failed.error}）`);
    else log.ok(`${step.name}：完成`);
  }
  log.info(`報表位置：${path.relative(process.cwd(), PATHS.reportDir)}`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} 份報表沒有做成功（詳見上方說明）`);
  }
}

main()
  .catch((error) => {
    log.fail('主流程', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await writeLogFile(PATHS.logFile).catch(() => {});
    // 一定要關 readline，否則它會讓事件迴圈一直有事做，程序印完訊息卻不結束。
    // 正常路徑上 `withSession` 的 finally 已經關過，但**登入階段就失敗時它不會執行**
    // ——那正是最常發生的情況（等驗證碼逾時）。這裡是最後一道保險。
    closePrompt();
    console.log(`\n完整執行紀錄：${PATHS.logFile}`);
  });
