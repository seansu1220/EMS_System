#!/usr/bin/env node
/**
 * 救護紀錄表查詢工具 CLI。
 *
 * 一般使用請雙擊專案的「捷徑\救護預警統計.bat」，不需要記這些指令。
 *
 * 用法：
 *   npm run tool:ems -- run                  跑完整流程（預設查上個月）
 *   npm run tool:ems -- run --month=2026-06  指定月份
 *   npm run tool:ems -- run --keep-raw       保留系統匯出的原始檔（含個資）
 *   npm run tool:ems -- probe                自動探測頁面結構（開發／改版時用）
 *   npm run tool:ems -- probe --manual       改為手動點選的探測模式
 *   npm run tool:ems -- check-sheet          檢查增減用的 Google 試算表能否讀取
 *   npm run tool:ems -- unlock               解鎖救護紀錄表（會實際調整為未結案）
 *   npm run tool:ems -- unlock --dry-run     只找出該解哪一張，不動手（排查用）
 *   npm run tool:ems -- unlock --temsis=A,B  直接指定 TEMSIS，不用互動輸入
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAutoProbe, runInteractiveProbe } from './probe.mjs';
import { startSession } from './session.mjs';
import { resolveMonthRange, getRecentRange } from './dateRange.mjs';
import { runUnlockFlow, promptTemsisList, printUnlockSummary } from './unlock.mjs';
import { exportBothDatasets } from './scrape.mjs';
import { readTable, describeWorkbook } from './workbook.mjs';
import {
  resolveSquadColumn,
  countBySquad,
  buildComparison,
  groupByBrigade,
  sortByRatioDesc,
  applyAdjustments,
} from './aggregate.mjs';
import { printReport, writeReport } from './report.mjs';
import { SQUAD_COLUMN_CANDIDATES, PATHS, BRIGADES, REPORT_FORMAT, UNLOCK } from './config.mjs';
import {
  resolveSheetSource,
  fetchSheetRows,
  describeSheet,
  resolveAdjustColumns,
  countAdjustmentsBySquad,
} from './adjustSheet.mjs';
import { log, closePrompt, writeLogFile } from './logger.mjs';

/** 可用的指令。 */
const COMMANDS = ['run', 'probe', 'check-sheet', 'unlock'];

/**
 * @typedef {Object} CliOptions
 * @property {'probe'|'run'|'check-sheet'|'unlock'} command
 * @property {string|undefined} month
 * @property {boolean} keepRaw
 * @property {boolean} manual
 * @property {string[]} temsis
 * @property {boolean} dryRun
 */

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
    /** probe 預設全自動；自動導航失敗時可用 --manual 改回手動點選。 */
    manual: args.includes('--manual'),
    temsis: temsisArg.split(/[\s,，;；]+/).filter(Boolean),
    /** unlock 預設會實際解鎖；加這個參數則只定位不動手（排查或驗證時用）。 */
    dryRun: args.includes('--dry-run'),
  };
}

/**
 * 讀取一份匯出檔並依分隊計數。
 * 欄名屬於檔案結構（非個人資料），完整記錄下來，日後欄位變動時可直接對照。
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
  return counts;
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
    const totalCounts = countFile(rawFiles.total, '總案件');
    const alertCounts = countFile(rawFiles.alert, '到院前預警案件');
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
 */
async function withSession(action) {
  const session = await startSession();
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
 * ⚠ 預設會**實際按下**「調整為未結案」（使用者 2026-07-31 在試跑驗證通過後決定採全自動）。
 *   只有明確定位到目標的案件才會動手，其餘一律略過；
 *   加 `--dry-run` 可回到「只定位不解鎖」的試跑模式。
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
  });
}

async function main() {
  const options = parseArgs(process.argv);
  log.step(`救護紀錄表查詢工具｜指令：${options.command}`);

  if (options.command === 'unlock') {
    await runUnlockCommand(options);
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
    await runReportFlow(session, monthRange, options.keepRaw);
  });
}

main()
  .catch((error) => {
    log.fail('主流程', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await writeLogFile(PATHS.logFile).catch(() => {});
    console.log(`\n完整執行紀錄：${PATHS.logFile}`);
  });
