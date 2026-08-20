/**
 * 值班監看的主迴圈：一個視窗同時看顧兩個系統。
 *
 * - 救護系統：有人在網頁上送出解鎖申請，就立刻處理（被動等）
 * - 一站通：使用者隨時把名單貼進終端機，下一輪就開通（主動給）
 *
 * ⚠ 這**不是繞過驗證碼**。兩個系統的驗證碼都由使用者本人各輸入過一次，
 *   之後只是**不讓那次登入過期**——等同你自己開著分頁不關。
 *   被踢掉時會停下來請本人重打，絕不自動辨識（見 TOOLS_SPEC 0.3）。
 *
 * **兩邊完全獨立**：一邊掉線、出錯或還在等人重登，都不影響另一邊繼續做事。
 * 這是刻意的——救護系統的解鎖是天天在用的功能，不能被新加的一站通拖累。
 *
 * 碰外部世界的每一件事都可以注入替身，因此整個迴圈可以離線測試
 * （比照 `ems-report/unlockWatch.mjs` 的既有作法）。
 */
import { WATCH } from './config.mjs';

/**
 * @typedef {Object} DutySide 一邊系統的照顧方式
 * @property {string} key 內部代號
 * @property {string} name 給人看的名稱
 * @property {() => Promise<boolean>} heartbeat 戳一下，回傳「是否仍登入著」
 * @property {(options: {timeoutMs: number}) => Promise<'已登入'|'重新登入'|'等不到'>} ensureSignedIn
 */

/** 把毫秒說成人話（給「已連續登入多久」用）。 */
export function describeDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} 分鐘`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
}

/** HH:mm，讓畫面上每一行看得出是什麼時候發生的。 */
export function clock(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把剛收到的輸入行併進「正在收集的那一批」。
 *
 * 規則與一次性流程一致：**空白行代表這一批貼完了**。
 * 一次貼上多行時全部會留著，不會只收到第一行（見 TOOLS_SPEC 0.7）。
 *
 * @param {string[]} collecting 目前正在收集的行（會被就地修改）
 * @param {string[]} incoming 這一輪新收到的行
 * @returns {string[][]} 這一輪收完整的批次（可能不只一批）
 */
export function foldBatches(collecting, incoming) {
  const ready = [];
  for (const line of incoming) {
    if (line.trim() === '') {
      if (collecting.length > 0) {
        ready.push(collecting.slice());
        collecting.length = 0;
      }
      continue; // 沒在收集時的空行只是使用者隨手按 Enter，忽略
    }
    collecting.push(line);
  }
  return ready;
}

/**
 * 一邊系統的執行狀態。
 * @param {DutySide} side
 */
function initialState(side, now) {
  return {
    side,
    /** 最近一次登入成功的時間；掉線期間為 null。 */
    signedInSince: now,
    lastHeartbeat: now,
    /** 正在等使用者回來登入嗎。 */
    waitingForLogin: false,
    lastReminder: 0,
  };
}

/**
 * 確認某一邊還登入著；掉線就把它標成「等人回來」並回報 false。
 *
 * **回報 false 不是失敗**，只代表這一邊現在不能做事；
 * 呼叫端要照常去做另一邊的工作。
 */
async function ensureSideReady(state, deps) {
  const { log } = deps;
  // **每次動手之前都問一次**，不能只在「已知掉線」時才問：
  // 掉線可能發生在上一次心跳之後，這時貼進來的名單會直接去點一個
  // 已經登出的畫面（測試抓到的）。已登入時這個檢查很便宜，只讀畫面。
  const result = await state.side.ensureSignedIn({ timeoutMs: WATCH.reloginWaitMs });

  if (result === '等不到') {
    if (!state.waitingForLogin) {
      markSignedOut(state, deps);
    } else if (deps.now() - state.lastReminder >= WATCH.reloginRemindEveryMs) {
      state.lastReminder = deps.now();
      deps.beep();
      log.warn(`[${clock()}] ${state.side.name}：還在等你回來登入。這段期間的工作會排隊等著。`);
    }
    return false;
  }

  if (state.waitingForLogin || result === '重新登入') {
    state.waitingForLogin = false;
    state.signedInSince = deps.now();
    state.lastHeartbeat = deps.now();
    log.ok(`[${clock()}] ${state.side.name}：已重新登入，繼續值班`);
  }
  return true;
}

/** 把某一邊標成掉線（並響一聲提醒）。 */
function markSignedOut(state, deps) {
  const { log } = deps;
  const lasted = state.signedInSince ? `（連續登入了 ${describeDuration(deps.now() - state.signedInSince)}）` : '';
  deps.beep();
  log.warn(
    `[${clock()}] ${state.side.name}：登入已被伺服器結束${lasted}。` +
      '請到那個瀏覽器視窗重新輸入驗證碼；在那之前工作會排隊等著，監看不會結束。',
  );
  state.waitingForLogin = true;
  state.lastReminder = deps.now();
  state.signedInSince = null;
}

/** 各邊到時間就戳一下，維持登入。 */
async function beatSides(states, deps) {
  for (const state of states) {
    if (state.waitingForLogin) continue;
    if (deps.now() - state.lastHeartbeat < WATCH.heartbeatMs) continue;
    state.lastHeartbeat = deps.now();
    const alive = await state.side.heartbeat().catch(() => false);
    if (!alive) markSignedOut(state, deps);
  }
}

/**
 * 處理雲端來的解鎖工單。
 * @returns {Promise<number>} 這一輪處理了幾筆
 */
async function handleUnlocks(state, deps, options) {
  const { log } = deps;
  const requests = await deps.fetchPendingUnlocks().catch((error) => {
    // 雲端讀不到多半是網路暫時斷了，不該讓整個監看死掉。
    log.warn(`[${clock()}] 查不到雲端工單（下一輪再試）：${error.message}`);
    return [];
  });
  if (requests.length === 0) return 0;

  log.step(`[${clock()}] 收到 ${requests.length} 筆解鎖工單`);
  if (options.dryRun) {
    log.warn('　試跑模式：不處理這幾筆，它們會留在「待處理」。');
    return 0;
  }
  if (!(await ensureSideReady(state, deps))) return 0;

  const result = await deps.processUnlocks(requests);
  state.lastHeartbeat = deps.now(); // 剛剛才操作過系統，心跳時間重算
  if (result.requeued > 0) {
    log.warn(`有 ${result.requeued} 筆因為掉線沒處理到，已退回待處理，下一輪會再跑。`);
  }
  return result.done;
}

/**
 * 處理使用者貼進來的名單。
 * @returns {Promise<number>} 這一輪處理了幾位
 */
async function handleRoster(state, deps, options, batch) {
  const { log } = deps;
  // 可能是「把檔案拖進視窗」，那要讀檔，所以這一步是非同步的。
  const parsed = await deps.parseRoster(batch);
  if (parsed.problems.length > 0) {
    log.warn(`　有 ${parsed.problems.length} 列沒辦法處理（會跳過），前幾筆：`);
    for (const problem of parsed.problems.slice(0, 10)) {
      log.warn(`　　第 ${problem.lineNumber} 列：${problem.reason}`);
    }
  }
  if (parsed.entries.length === 0) {
    log.warn('　這一批沒有可以處理的人，略過。');
    return 0;
  }

  log.step(`[${clock()}] 收到名單 ${parsed.entries.length} 位`);
  if (parsed.duplicateCount > 0) log.info(`　（有 ${parsed.duplicateCount} 筆重複，已併成一筆）`);
  if (options.dryRun) {
    log.warn('　試跑模式：會走完流程但不會按「確定」。');
  }
  if (!(await ensureSideReady(state, deps))) {
    log.warn('　那邊還沒登入，這一批先留著，登入後再處理。');
    return 0;
  }

  const results = await deps.processRoster(parsed.entries, { execute: !options.dryRun });
  state.lastHeartbeat = deps.now();
  return results.length;
}

/**
 * 值班監看主迴圈（**不會自己結束**，關掉視窗或按 Ctrl+C 才停）。
 *
 * @param {{unlockSide: DutySide|null, mciSide: DutySide|null}} sides
 *   給 null 代表這一邊不看顧（例如只想顧一站通）
 * @param {{dryRun: boolean, shouldStop: () => boolean}} options
 * @param {object} deps 碰外部世界的事情，全部可注入替身
 */
export async function runDutyWatch(sides, options, deps) {
  const { log } = deps;
  const states = [];
  if (sides.unlockSide) states.push(initialState(sides.unlockSide, deps.now()));
  if (sides.mciSide) states.push(initialState(sides.mciSide, deps.now()));
  const unlockState = states.find((state) => state.side.key === 'unlock') ?? null;
  const mciState = states.find((state) => state.side.key === 'mci') ?? null;

  /** 還在收集中的名單行（等使用者按空白行 Enter）。 */
  const collecting = [];
  let unlocked = 0;
  let granted = 0;
  let lastStatus = deps.now();

  announceStart(sides, options, deps);

  while (!options.shouldStop()) {
    // 一、先收使用者貼進來的名單（不阻塞，貼多少收多少）
    if (mciState) {
      for (const batch of foldBatches(collecting, deps.takeRosterLines())) {
        granted += await handleRoster(mciState, deps, options, batch).catch((error) => {
          log.fail('開通名單', error);
          return 0;
        });
      }
    }

    // 二、再看雲端有沒有解鎖工單
    if (unlockState) {
      unlocked += await handleUnlocks(unlockState, deps, options).catch((error) => {
        log.fail('解鎖工單', error);
        return 0;
      });
    }

    // 三、各邊維持登入；掉線的那一邊只是暫停，另一邊照常做事
    await beatSides(states, deps);
    for (const state of states) {
      if (state.waitingForLogin) await ensureSideReady(state, deps);
    }

    if (deps.now() - lastStatus >= WATCH.statusEveryMs) {
      lastStatus = deps.now();
      reportStatus(states, { unlocked, granted, collecting }, deps);
    }

    await deps.sleep(WATCH.pollMs);
  }

  log.step('收到結束指示，停止值班');
  log.info(`這次總共處理了 ${unlocked} 筆解鎖、${granted} 位權限開通。`);
  return { unlocked, granted };
}

/** 開場說明：讓使用者知道現在可以做什麼。 */
function announceStart(sides, options, deps) {
  const { log } = deps;
  log.step('進入值班監看');
  if (sides.unlockSide) {
    log.info(`${sides.unlockSide.name}：每 ${WATCH.pollMs / 1000} 秒查一次有沒有新的解鎖工單。`);
  }
  if (sides.mciSide) {
    log.info(`${sides.mciSide.name}：直接把名單貼進這個視窗（一行一位：單位,姓名），`);
    log.info('　或把 Excel 檔拖進這個視窗。');
    log.info('　貼完後在空白行按一次 Enter 就會開始處理。右鍵即為貼上。');
  }
  log.info(`每 ${WATCH.heartbeatMs / 60000} 分鐘各戳一次系統維持登入；掉線時會在畫面上請你重打驗證碼。`);
  if (options.dryRun) log.warn('本次為試跑：不解鎖、不回寫，開通也不會按「確定」。');
  log.info('要結束請直接關掉這個視窗，或按 Ctrl+C。');
}

/** 定期回報還活著。 */
function reportStatus(states, counters, deps) {
  const { log } = deps;
  const parts = states.map((state) => {
    if (state.waitingForLogin) return `${state.side.name}：等你重新登入`;
    return `${state.side.name}：已連續登入 ${describeDuration(deps.now() - state.signedInSince)}`;
  });
  log.info(
    `[${clock()}] 值班中｜${parts.join('｜')}` +
      `｜已處理 ${counters.unlocked} 筆解鎖、${counters.granted} 位開通` +
      (counters.collecting.length > 0 ? `｜名單收集中（${counters.collecting.length} 行，按空白行 Enter 開始）` : ''),
  );
}
