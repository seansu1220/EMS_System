#!/usr/bin/env node
/**
 * 「值班監看」總管 CLI：**一個視窗同時看顧兩個系統**。
 *
 * 一般使用請雙擊專案的「捷徑\值班監看.bat」，不需要記這些指令。
 *
 * 用法：
 *   npm run tool:duty                    試跑：兩邊都顧，但不解鎖、開通也不按確定
 *   npm run tool:duty -- --execute       真的處理（解鎖會回寫、開通會按確定）
 *   npm run tool:duty -- --only=unlock   只顧救護系統的解鎖工單
 *   npm run tool:duty -- --only=mci      只顧一站通的權限開通
 *   npm run tool:duty -- --fresh-login   兩邊都重新登入
 *
 * ⚠ 會開**兩個瀏覽器視窗**（兩個系統的帳號不同，各要登入一次）。
 *   刻意不合併成一個視窗：救護系統的登入流程是天天在用、已經實測過的，
 *   為了新功能去動它不划算，而且分開的話一邊掉線也不會干擾另一邊。
 *
 * ⚠ 驗證碼仍由本人輸入（見 TOOLS_SPEC 0.3）。這個工具省下的是**重複登入**：
 *   一整天只要在開始時各打一次，之後靠心跳維持。
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { UNLOCK } from '../ems-report/config.mjs';
import { getRecentRange } from '../ems-report/dateRange.mjs';
import {
  log,
  closePrompt,
  enableLiveLog,
  startLineBuffering,
  stopLineBuffering,
  takeBufferedLines,
} from '../ems-report/logger.mjs';
import { startSession as startEmsSession, ensureSignedIn as ensureEmsSignedIn } from '../ems-report/session.mjs';
import { closeQueue, connectQueue, fetchPendingRequests } from '../ems-report/unlockQueue.mjs';
import { heartbeat as emsHeartbeat, processBatch } from '../ems-report/unlockWatch.mjs';

import { enableLiveLog as enableMciLiveLog } from '../mci-perm/logger.mjs';
import {
  startSession as startMciSession,
  ensureSignedIn as ensureMciSignedIn,
  isSignedIn as isMciSignedIn,
  loadSettings as loadMciSettings,
} from '../mci-perm/session.mjs';
import { backToMainMenu, grantAll, openAccountPermissionPage } from '../mci-perm/grantFlow.mjs';
import { parseRoster } from '../mci-perm/roster.mjs';
import { printSummary, pruneOldResults, writeResultReport } from '../mci-perm/resultReport.mjs';

import { PATHS, WATCH } from './config.mjs';
import { runDutyWatch } from './dutyLoop.mjs';

/**
 * @typedef {Object} DutyOptions
 * @property {boolean} execute 真的動手（解鎖回寫、開通按確定）
 * @property {boolean} freshLogin
 * @property {'both'|'unlock'|'mci'} only 要顧哪幾邊
 */

/**
 * 解析命令列參數。
 * @param {string[]} args
 * @returns {DutyOptions}
 */
export function parseArgs(args) {
  const onlyArg = args.find((arg) => arg.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).trim() : 'both';
  if (!['both', 'unlock', 'mci'].includes(only)) {
    throw new Error(`--only 只能是 unlock 或 mci（收到的是「${only}」）`);
  }
  return {
    execute: args.includes('--execute'),
    freshLogin: args.includes('--fresh-login'),
    only: /** @type {'both'|'unlock'|'mci'} */ (only),
  };
}

/**
 * 在終端機響一聲。
 *
 * 掉線是「需要人回來處理」的唯一時刻，而人多半不在螢幕前。
 * 響一下至少讓還在辦公室的人聽得到。
 */
function beep(times = 3) {
  for (let count = 0; count < times; count += 1) process.stdout.write(String.fromCharCode(7));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一站通的心跳：回主畫面再進一次查詢頁。
 *
 * 這是流程本來就會做的兩次導航，**不送出任何查詢、不改任何資料**。
 * 刻意不用重新整理網址——那一頁重新 GET 會退回登入表單（見 TOOLS_SPEC 6.8）。
 *
 * @returns {Promise<boolean>} 心跳之後是否仍在登入狀態
 */
async function mciHeartbeat(session) {
  try {
    await backToMainMenu(session);
    await openAccountPermissionPage(session);
  } catch (error) {
    // 切頁失敗多半就是被踢回登入頁了，交給下面的檢查判定。
    log.info(`一站通心跳切頁沒成功（${error instanceof Error ? error.message : error}），檢查是否還登入著`);
  }
  return isMciSignedIn(session.page);
}

/** 開救護系統的視窗並登入。 */
async function openUnlockSide(options) {
  log.step('［1／2］救護系統：請在開啟的瀏覽器完成登入');
  const session = await startEmsSession({ freshLogin: options.freshLogin });
  // 解鎖流程要用的查詢期間；監看跑很久，掛在 session 上一起帶著走。
  session.range = getRecentRange(UNLOCK.lookbackMonths);
  const queue = await connectQueue();
  return { session, queue };
}

/** 開一站通的視窗並登入。 */
async function openMciSide(options) {
  log.step('［2／2］一站通：請在**另一個**瀏覽器視窗完成登入');
  const session = await startMciSession({ freshLogin: options.freshLogin });
  return { session };
}

/** 組出救護系統這一邊的照顧方式。 */
function buildUnlockSide(unlock) {
  return {
    key: 'unlock',
    name: '救護系統',
    heartbeat: () => emsHeartbeat(unlock.session),
    ensureSignedIn: (opts) => ensureEmsSignedIn(unlock.session, opts),
  };
}

/** 組出一站通這一邊的照顧方式。 */
function buildMciSide(mci) {
  return {
    key: 'mci',
    name: '一站通',
    heartbeat: () => mciHeartbeat(mci.session),
    ensureSignedIn: (opts) => ensureMciSignedIn(mci.session, opts),
  };
}

/** 把兩邊的實際動作包成主迴圈要用的 deps。 */
function buildDeps(unlock, mci) {
  const defaultUnit = loadMciSettings().defaultUnit;
  return {
    log,
    beep,
    sleep,
    now: () => Date.now(),
    takeRosterLines: () => takeBufferedLines(),
    parseRoster: (lines) => parseRoster(lines, { defaultUnit }),
    fetchPendingUnlocks: () => (unlock ? fetchPendingRequests(unlock.queue) : Promise.resolve([])),
    processUnlocks: (requests) => processBatch(unlock.session, unlock.queue, requests),
    processRoster: async (entries, { execute }) => {
      const results = await grantAll(mci.session, entries, { execute });
      printSummary(results);
      const filePath = await writeResultReport(results, { execute });
      log.ok(`結果清單：${filePath}`);
      log.info('（該檔含姓名，只供核對與補做，請勿外傳）');
      await pruneOldResults();
      return results;
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // 監看會跑很久，而且多半是被直接關掉視窗而結束——只在結束時落檔等於沒有紀錄。
  // 兩邊的 logger 都指到同一個檔案，這樣一份紀錄就看得到全部經過。
  await enableLiveLog(PATHS.watchLog);
  await enableMciLiveLog(PATHS.watchLog);
  log.step('值班監看｜同時看顧「救護系統解鎖工單」與「一站通權限開通」');
  log.info(`即時紀錄：${path.relative(process.cwd(), PATHS.watchLog)}（邊跑邊寫，關掉視窗也留得住）`);
  if (!options.execute) {
    log.warn('本次為試跑：不會解鎖、不會回寫，開通也不會按「確定」。要真的處理請加 --execute。');
  }

  /** 關掉視窗或按 Ctrl+C 時，讓迴圈跑完這一輪就收工。 */
  let stopping = false;
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    log.warn('收到結束指示，正在收尾（不會中斷正在處理的那一筆）…');
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  let unlock = null;
  let mci = null;
  try {
    if (options.only !== 'mci') unlock = await openUnlockSide(options);
    if (options.only !== 'unlock') mci = await openMciSide(options);

    // 一次貼上多行時，行會在兩次取用之間到達，必須先開緩衝才不會漏（見 TOOLS_SPEC 0.7）。
    if (mci) await startLineBuffering();

    await runDutyWatch(
      {
        unlockSide: unlock ? buildUnlockSide(unlock) : null,
        mciSide: mci ? buildMciSide(mci) : null,
      },
      { dryRun: !options.execute, shouldStop: () => stopping },
      buildDeps(unlock, mci),
    );
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    stopLineBuffering();
    await mci?.session.close().catch(() => {});
    await unlock?.session.close().catch(() => {});
    if (unlock) await closeQueue(unlock.queue).catch(() => {});
    closePrompt();
    log.info('兩邊的瀏覽器都已關閉');
  }
}

/** 是不是「直接被執行」（被測試 import 時不能自己跑起來）。 */
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isDirectRun) {
  main().catch((error) => {
    log.fail('值班監看', error);
    process.exitCode = 1;
    closePrompt();
  });
}
