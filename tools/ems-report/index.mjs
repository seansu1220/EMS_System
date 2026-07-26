#!/usr/bin/env node
/**
 * 救護紀錄表查詢工具 CLI。
 *
 * 用法：
 *   npm run tool:ems -- probe              互動式探測頁面結構（開發用）
 *   npm run tool:ems -- run                跑完整流程（查詢→匯出→彙總）
 *   npm run tool:ems -- run --month=2026-06  指定月份（預設為上個月）
 *   npm run tool:ems -- run --keep-raw     保留系統匯出的原始 Excel（預設用完即刪）
 */
import { runInteractiveProbe } from './probe.mjs';
import { startSession } from './session.mjs';
import { resolveMonthRange } from './dateRange.mjs';
import { log, closePrompt } from './logger.mjs';

/**
 * @typedef {Object} CliOptions
 * @property {'probe'|'run'} command
 * @property {string|undefined} month
 * @property {boolean} keepRaw
 */

/** 解析命令列參數。 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('--')) ?? 'probe';
  if (command !== 'probe' && command !== 'run') {
    throw new Error(`未知的指令：${command}（可用：probe、run）`);
  }
  return {
    command,
    month: args.find((arg) => arg.startsWith('--month='))?.split('=')[1],
    keepRaw: args.includes('--keep-raw'),
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const monthRange = resolveMonthRange(options.month);

  log.step(`救護紀錄表查詢工具｜指令：${options.command}`);
  log.info(`查詢期間：${monthRange.start} ~ ${monthRange.end}（${monthRange.label}）`);

  const session = await startSession();
  try {
    if (options.command === 'probe') {
      await runInteractiveProbe(session.context);
      return;
    }
    throw new Error(
      'run 指令尚未實作：需先用 probe 取得「報表系統→救護紀錄表查詢」的頁面結構後才能寫自動化步驟。',
    );
  } finally {
    await session.close();
    closePrompt();
    log.info('瀏覽器已關閉');
  }
}

main().catch((error) => {
  log.fail('主流程', error);
  process.exitCode = 1;
});
