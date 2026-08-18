#!/usr/bin/env node
/**
 * 「開通大量傷患系統權限」CLI。
 *
 * 一般使用請雙擊專案的「捷徑\開通大量傷患系統權限.bat」，不需要記這些指令。
 *
 * 用法：
 *   npm run tool:mci -- grant                    試跑：走完整個流程但**不按確定**
 *   npm run tool:mci -- grant --execute          真的開通（會先請你確認一次）
 *   npm run tool:mci -- grant --file=名單.xlsx    從檔案讀名單（也吃 .csv／.txt）
 *   npm run tool:mci -- grant --unit=大溪分隊      整份名單都用這個單位（名單只要寫姓名）
 *   npm run tool:mci -- grant --limit=3          只處理前 3 位（先確認流程正確再跑整份）
 *   npm run tool:mci -- probe                    探測頁面結構（開發／改版卡住時用）
 *   npm run tool:mci -- probe --unit=X --name=Y  連結果畫面與權限畫面一起探測（不會按確定）
 *
 * 任何指令都可加 --fresh-login：捨棄上次保存的登入狀態，強制重新登入。
 *
 * ⚠ 這個工具會**改動別人的系統權限**，因此預設是試跑；要真的設定必須明確加 --execute。
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PATHS } from './config.mjs';
import { grantAll } from './grantFlow.mjs';
import { log, closePrompt, prompt, startLineBuffering, stopLineBuffering, writeLogFile } from './logger.mjs';
import { runProbe } from './probe.mjs';
import { parseRoster, readRosterFile } from './roster.mjs';
import { loadSettings, startSession } from './session.mjs';
import { printSummary, pruneOldResults, writeResultReport } from './resultReport.mjs';

const COMMANDS = ['grant', 'probe'];

/**
 * @typedef {Object} CliOptions
 * @property {'grant'|'probe'} command
 * @property {boolean} execute 真的按下確定
 * @property {boolean} freshLogin
 * @property {string} file 名單檔路徑（空字串代表改用互動貼上）
 * @property {string} unit 覆寫整份名單的單位
 * @property {string} name probe 用：要試查的姓名
 * @property {number} limit 只處理前幾位（0＝不限）
 */

/**
 * 解析命令列參數。
 * @param {string[]} args
 * @returns {CliOptions}
 */
export function parseArgs(args) {
  const command = args.find((arg) => !arg.startsWith('--')) ?? 'grant';
  if (!COMMANDS.includes(command)) {
    throw new Error(`未知的指令：${command}（可用：${COMMANDS.join('、')}）`);
  }
  const valueOf = (key) => {
    const hit = args.find((arg) => arg.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3).trim() : '';
  };
  const limitText = valueOf('limit');
  const limit = limitText ? Number.parseInt(limitText, 10) : 0;
  if (limitText && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit 要給正整數，收到的是「${limitText}」`);
  }
  return {
    command: /** @type {'grant'|'probe'} */ (command),
    execute: args.includes('--execute'),
    freshLogin: args.includes('--fresh-login'),
    file: valueOf('file'),
    unit: valueOf('unit'),
    name: valueOf('name'),
    limit,
  };
}

/**
 * 請使用者把名單貼進終端機。
 *
 * 手感沿用解鎖工具：一次貼上整段沒問題，空白行按 Enter 代表貼完了。
 * @returns {Promise<string[]>}
 */
async function promptRosterLines() {
  log.step('請貼上名單（每行一位：單位,姓名）');
  log.info('可以直接從 Excel 複製兩欄整段貼上；一行一位再按 Enter 也可以。');
  log.info('全部貼完後，在「空白的那一行」再按一次 Enter，才會開始執行。');
  log.info('只寫姓名也可以，但要先用 --unit=單位 指定，或在 .env 設 MCI_DEFAULT_UNIT。');
  log.info('貼不上去時：在黑色視窗內按「滑鼠右鍵」就是貼上（Ctrl+V 常被輸入法吃掉）。');
  /** @type {string[]} */
  const collected = [];
  // 一次貼上多行時，多出來的行會在兩次 prompt 之間到達，必須先開緩衝才不會漏。
  await startLineBuffering();
  try {
    for (;;) {
      // 提示字串刻意維持**短且純 ASCII**：Windows 主控台按下 Enter 後會依提示字寬重繪，
      // 提示含全形字時會把剛貼上的內容抹掉（讀得到，但使用者看不到）。
      const line = await prompt(`  [${collected.length + 1}] `);
      // null＝輸入串流結束（EOF），空字串＝使用者按了 Enter，兩者都當作貼完了。
      if (line === null || line === '') break;
      collected.push(line);
      log.info(`已收到 ${collected.length} 行`);
    }
  } finally {
    stopLineBuffering();
  }
  return collected;
}

/**
 * 取得這次要處理的名單。
 * @param {CliOptions} options
 * @returns {Promise<import('./roster.mjs').RosterEntry[]>}
 */
async function resolveRoster(options) {
  const settings = loadSettings();
  const defaultUnit = options.unit || settings.defaultUnit;
  const parseOptions = { defaultUnit };

  const result = options.file
    ? await readRosterFile(options.file, parseOptions)
    : parseRoster(await promptRosterLines(), parseOptions);

  if (options.unit) {
    // --unit 是明確指令，蓋過名單裡寫的單位。
    result.entries = result.entries.map((entry) => ({ ...entry, unit: options.unit }));
  }

  log.step(`名單共 ${result.entries.length} 位`);
  if (result.duplicateCount > 0) log.info(`（有 ${result.duplicateCount} 筆重複，已併成一筆）`);
  for (const problem of result.problems) {
    log.warn(`第 ${problem.lineNumber} 行沒辦法處理：${problem.reason}`);
  }
  if (result.entries.length === 0) throw new Error('名單裡沒有任何可以處理的人');

  if (options.limit > 0 && result.entries.length > options.limit) {
    log.info(`依 --limit=${options.limit} 只處理前 ${options.limit} 位`);
    return result.entries.slice(0, options.limit);
  }
  return result.entries;
}

/**
 * 正式執行前的確認。
 *
 * 這一步會**真的改動別人的系統權限**，而且是一次改一整批，
 * 所以寧可多問一句：名單貼錯（例如貼到別的單位）在按下去之前還救得回來。
 *
 * @returns {Promise<boolean>} 使用者是否同意繼續
 */
async function confirmExecute(entries) {
  log.warn(`即將對 ${entries.length} 位設定「MCI002 縣市端使用者」權限，這會真的寫進系統。`);
  const answer = await prompt('  yes/no: ');
  const agreed = ['y', 'yes'].includes(String(answer ?? '').toLowerCase());
  if (!agreed) log.info('已取消，系統沒有被改動。');
  return agreed;
}

/** 執行 grant 指令。 */
async function runGrant(options) {
  const entries = await resolveRoster(options);

  if (options.execute) {
    if (!(await confirmExecute(entries))) return;
  } else {
    log.step('試跑模式：會走完整個流程，但不會按下「確定」');
    log.info('確認每一位都走得通之後，再加上 --execute 才會真的開通。');
  }

  const session = await startSession({ freshLogin: options.freshLogin });
  try {
    const results = await grantAll(session, entries, { execute: options.execute });
    printSummary(results);
    const filePath = await writeResultReport(results, { execute: options.execute });
    log.ok(`結果清單：${filePath}`);
    log.info('（該檔含姓名，只供核對與補做，請勿外傳）');
    await pruneOldResults();
  } finally {
    await session.close();
  }
}

/** 執行 probe 指令。 */
async function runProbeCommand(options) {
  const session = await startSession({ freshLogin: options.freshLogin });
  try {
    await runProbe(session, { unit: options.unit, name: options.name });
  } finally {
    await session.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  log.step(`開通大量傷患系統權限｜指令：${options.command}`);

  if (options.command === 'probe') await runProbeCommand(options);
  else await runGrant(options);
}

/** 是不是「直接被執行」（被測試 import 時不能自己跑起來）。 */
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isDirectRun) {
  main()
    .catch((error) => {
      log.fail('主流程', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await writeLogFile(PATHS.logFile).catch(() => {});
      // 一定要關 readline，否則它會讓事件迴圈一直有事做，程序印完訊息卻不結束。
      // 登入階段就失敗時（等驗證碼逾時是最常見的），前面的 finally 不會執行到，
      // 這裡是最後一道保險。
      closePrompt();
      console.log(`\n完整執行紀錄：${PATHS.logFile}`);
    });
}
