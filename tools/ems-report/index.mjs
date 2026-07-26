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
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAutoProbe, runInteractiveProbe } from './probe.mjs';
import { startSession } from './session.mjs';
import { resolveMonthRange } from './dateRange.mjs';
import { exportBothDatasets } from './scrape.mjs';
import { readTable, describeWorkbook } from './workbook.mjs';
import { resolveSquadColumn, countBySquad, buildComparison, summarize } from './aggregate.mjs';
import { printReport, writeReport } from './report.mjs';
import { SQUAD_COLUMN_CANDIDATES, PATHS } from './config.mjs';
import { log, closePrompt, writeLogFile } from './logger.mjs';

/**
 * @typedef {Object} CliOptions
 * @property {'probe'|'run'} command
 * @property {string|undefined} month
 * @property {boolean} keepRaw
 * @property {boolean} manual
 */

/** 解析命令列參數。 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('--')) ?? 'run';
  if (command !== 'probe' && command !== 'run') {
    throw new Error(`未知的指令：${command}（可用：run、probe）`);
  }
  return {
    command,
    month: args.find((arg) => arg.startsWith('--month='))?.split('=')[1],
    keepRaw: args.includes('--keep-raw'),
    /** probe 預設全自動；自動導航失敗時可用 --manual 改回手動點選。 */
    manual: args.includes('--manual'),
  };
}

/**
 * 讀取一份匯出檔並依分隊計數。
 * 欄名屬於檔案結構（非個人資料），完整記錄下來，日後欄位變動時可直接對照。
 */
function countFile(filePath, label) {
  const table = readTable(filePath, SQUAD_COLUMN_CANDIDATES);
  log.info(`${label}：${table.rows.length} 筆`);
  log.info(`  匯出檔欄位（${table.headers.length} 欄）：${table.headers.join(' ｜ ')}`);

  const { column, reason } = resolveSquadColumn(table.headers, table.rows, SQUAD_COLUMN_CANDIDATES);
  const counts = countBySquad(table.rows, column);
  log.info(`  分隊欄位判定為「${column}」（${reason}），共 ${counts.size} 個分隊`);

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

  if (stats.length === 0) {
    log.warn('查詢結果沒有任何案件，請確認查詢期間是否正確。');
  }
  const summary = summarize(stats);
  printReport(stats, summary, monthRange);
  await writeReport(stats, summary, monthRange);

  if (keepRaw) {
    log.warn(`依 --keep-raw 保留原始明細檔於 ${path.dirname(rawFiles.total)}（含個資，請自行妥善處理）`);
  } else {
    await removeRawFiles(rawFiles);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const monthRange = resolveMonthRange(options.month);

  log.step(`救護紀錄表查詢工具｜指令：${options.command}`);
  log.info(`查詢期間：${monthRange.start} ~ ${monthRange.end}（${monthRange.label}）`);

  const session = await startSession();
  try {
    if (options.command === 'probe') {
      await (options.manual ? runInteractiveProbe(session.context) : runAutoProbe(session.context, session.page));
      return;
    }
    await runReportFlow(session, monthRange, options.keepRaw);
  } catch (error) {
    // 失敗時把當下的 frame 狀態一併記進紀錄檔，方便判斷卡在哪一頁。
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

main()
  .catch((error) => {
    log.fail('主流程', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await writeLogFile(PATHS.logFile).catch(() => {});
    console.log(`\n完整執行紀錄：${PATHS.logFile}`);
  });
