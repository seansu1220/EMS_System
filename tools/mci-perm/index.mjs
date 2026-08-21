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
 *   npm run tool:mci -- grant --execute --no-verify  開通後不回頭查證（快一點，但不建議）
 *   npm run tool:mci -- grant --execute --restart    捨棄上次進度，整份從頭跑
 *
 * ⚠ 名單很長時（實際跑過 1890 位、約 10 小時）**會自動接續**：
 *   做完的人記在 out/progress/，下次跑同一份名單直接從斷點繼續。
 *   npm run tool:mci -- revoke                   試跑：列出「這次新開通的」有誰，不動手
 *   npm run tool:mci -- revoke --execute         真的把那些人的 MCI 勾選取消掉
 *   npm run tool:mci -- probe                    探測頁面結構（開發／改版卡住時用）
 *   npm run tool:mci -- probe --unit=X --name=Y  連結果畫面與權限畫面一起探測（不會按確定）
 *
 * 任何指令都可加 --fresh-login：捨棄上次保存的登入狀態，強制重新登入。
 *
 * ⚠ 這個工具會**改動別人的系統權限**，因此預設是試跑；要真的設定必須明確加 --execute。
 */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PATHS } from './config.mjs';
import { OUTCOME, grantAll, revokeAll } from './grantFlow.mjs';
import { log, closePrompt, prompt, startLineBuffering, stopLineBuffering, writeLogFile } from './logger.mjs';
import { runProbe } from './probe.mjs';
import { readRosterFile, resolveRosterInput } from './roster.mjs';
import {
  appendProgress,
  countByOutcome,
  entriesWithOutcome,
  loadProgress,
  progressFileFor,
  revokeProgressFileFor,
  splitByProgress,
} from './progress.mjs';
import { ensureSignedIn, loadSettings, startSession } from './session.mjs';
import { printSummary, pruneOldResults, writeResultReport } from './resultReport.mjs';

const COMMANDS = ['grant', 'revoke', 'probe'];

/** 終端機最多先列幾筆問題列（其餘寫進結果檔，免得洗掉畫面）。 */
const PROBLEM_PREVIEW = 10;

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
    /** 開通後回頭再查一次，確認真的存進去了（預設開啟）。 */
    verify: !args.includes('--no-verify'),
    freshLogin: args.includes('--fresh-login'),
    /** 捨棄上次的進度，整份從頭跑。 */
    restart: args.includes('--restart'),
    file: valueOf('file'),
    /** 撤銷時要依據哪一份開通進度檔（留空＝依 --file 推出來的那份）。 */
    progress: valueOf('progress'),
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
  log.info('也可以直接把 Excel 檔「拖進這個視窗」再按 Enter，它會讀那個檔。');
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
 * @returns {Promise<{entries: import('./roster.mjs').RosterEntry[],
 *   problems: import('./roster.mjs').RosterProblem[]}>}
 */
async function resolveRoster(options) {
  const settings = loadSettings();
  const defaultUnit = options.unit || settings.defaultUnit;
  const parseOptions = { defaultUnit };

  const result = options.file
    ? await readRosterFile(options.file, parseOptions)
    : await resolveRosterInput(await promptRosterLines(), parseOptions);
  if (result.sourceFile) log.ok(`讀取名單檔：${result.sourceFile}`);

  if (options.unit) {
    // --unit 是明確指令，蓋過名單裡寫的單位。
    result.entries = result.entries.map((entry) => ({ ...entry, unit: options.unit }));
  }

  log.step(`名單共 ${result.entries.length} 位`);
  if (result.duplicateCount > 0) log.info(`（有 ${result.duplicateCount} 筆重複，已併成一筆）`);
  if (result.problems.length > 0) {
    // 名單長的時候問題列可能有幾十筆，全印會把畫面洗掉。
    // 這裡只給前幾筆讓人知道是什麼狀況，完整清單寫進結果檔。
    log.warn(`有 ${result.problems.length} 列沒辦法處理（會跳過），前幾筆：`);
    for (const problem of result.problems.slice(0, PROBLEM_PREVIEW)) {
      log.warn(`  第 ${problem.lineNumber} 列：${problem.reason}`);
    }
    if (result.problems.length > PROBLEM_PREVIEW) {
      log.info(`  …其餘 ${result.problems.length - PROBLEM_PREVIEW} 列都列在最後的結果清單裡`);
    }
  }
  if (result.entries.length === 0) throw new Error('名單裡沒有任何可以處理的人');

  if (options.limit > 0 && result.entries.length > options.limit) {
    log.info(`依 --limit=${options.limit} 只處理前 ${options.limit} 位`);
    return { entries: result.entries.slice(0, options.limit), problems: result.problems };
  }
  return { entries: result.entries, problems: result.problems };
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
  const { entries: all, problems } = await resolveRoster(options);

  // 接著上次跑：做完的人跳過，沒做完的（含上次失敗的）再試一次。
  const progressFile = progressFileFor(options.file);
  if (options.restart) {
    await fs.rm(progressFile, { force: true }).catch(() => {});
    log.info('依 --restart 捨棄上次的進度，這次整份從頭跑');
  }
  const progress = await loadProgress(progressFile);
  const { todo, skipped } = splitByProgress(all, progress);
  if (skipped.length > 0) {
    const counts = countByOutcome(progress);
    log.step(`接續上次的進度：已完成 ${skipped.length} 位，這次要做 ${todo.length} 位`);
    log.info(`（上次的結果：${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join('、')}）`);
    log.info(`進度檔：${progressFile}`);
  }
  const entries = todo;
  if (entries.length === 0) {
    log.ok('這份名單已經全部做完了，沒有要處理的人。');
    log.info('要整份重做請加 --restart。');
    return;
  }

  if (options.execute) {
    if (!(await confirmExecute(entries))) return;
  } else {
    log.step('試跑模式：會走完整個流程，但不會按下「確定」');
    log.info('確認每一位都走得通之後，再加上 --execute 才會真的開通。');
  }

  const session = await startSession({ freshLogin: options.freshLogin });
  try {
    const results = await grantAll(session, entries, {
      execute: options.execute,
      verify: options.verify,
      // 做完一位就記一次，中途關掉視窗前面做完的才不會白跑。
      onProgress: options.execute ? (entry, result) => appendProgress(progressFile, entry, result) : undefined,
      // 掉線時在同一個視窗等本人重登（名單很長時一定會遇到）。
      ensureSignedIn: () => ensureSignedIn(session),
    });
    printSummary(results);
    const filePath = await writeResultReport(results, { execute: options.execute, problems });
    log.ok(`結果清單：${filePath}`);
    log.info('（該檔含姓名，只供核對與補做，請勿外傳）');
    if (options.execute) log.info(`進度已存到：${progressFile}（下次跑同一份名單會接著做）`);
    await pruneOldResults();
  } finally {
    await session.close();
  }
}

/**
 * 執行 revoke 指令：把「這一次新開通的」權限收回來。
 *
 * ⚠ 名單來源是**開通時的進度檔**，只取結果為「已開通」的那些人。
 *   「本來就有了」的不在裡面，因此**不會被動到**——這正是使用者要的：
 *   本來有權限的留著，只還原這次新開的。
 */
async function runRevoke(options) {
  const sourceFile = options.progress || progressFileFor(options.file);
  const source = await loadProgress(sourceFile);
  if (source.size === 0) {
    throw new Error(
      `找不到開通紀錄：${sourceFile}
` +
        '（撤銷是依據開通時留下的進度檔決定「誰是這次新開的」，沒有它就無從分辨）',
    );
  }

  const counts = countByOutcome(source);
  const newlyGranted = entriesWithOutcome(source, OUTCOME.granted);
  const untouched = counts[OUTCOME.alreadyGranted] ?? 0;
  log.step(`開通紀錄：${sourceFile}`);
  log.info(`這次新開通的：${newlyGranted.length} 位　←　要取消的就是這些`);
  log.info(`本來就有權限的：${untouched} 位　←　完全不會動到`);

  // 撤銷自己記一份進度（不寫回開通的那一份，否則就分不出誰本來就有權限了）。
  const revokeFile = revokeProgressFileFor(sourceFile);
  if (options.restart) {
    await fs.rm(revokeFile, { force: true }).catch(() => {});
    log.info('依 --restart 捨棄上次的撤銷進度');
  }
  const done = await loadProgress(revokeFile);
  const { todo, skipped } = splitByProgress(newlyGranted, done);
  if (skipped.length > 0) log.info(`已經取消過的 ${skipped.length} 位跳過，這次要做 ${todo.length} 位`);
  if (todo.length === 0) {
    log.ok('沒有要取消的人（都做完了）。');
    return;
  }

  if (options.execute) {
    log.warn(`即將把 ${todo.length} 位的「MCI 大量傷病患救護管理系統」勾選取消掉，這會真的寫進系統。`);
    log.info(`（本來就有權限的 ${untouched} 位不在這份名單裡，不會被動到）`);
    const answer = await prompt('  yes/no: ');
    if (!['y', 'yes'].includes(String(answer ?? '').toLowerCase())) {
      log.info('已取消，系統沒有被改動。');
      return;
    }
  } else {
    log.step('試跑模式：只會看每個人現在的狀態，不會取消任何權限');
    log.info('確認無誤後再加上 --execute 才會真的取消。');
  }

  const session = await startSession({ freshLogin: options.freshLogin });
  try {
    const results = await revokeAll(session, todo, {
      execute: options.execute,
      verify: options.verify,
      onProgress: options.execute ? (entry, result) => appendProgress(revokeFile, entry, result) : undefined,
      ensureSignedIn: () => ensureSignedIn(session),
    });
    printSummary(results);
    const filePath = await writeResultReport(results, { execute: options.execute, action: '取消' });
    log.ok(`結果清單：${filePath}`);
    if (options.execute) log.info(`撤銷進度：${revokeFile}（下次跑會接著做）`);
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
  else if (options.command === 'revoke') await runRevoke(options);
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
