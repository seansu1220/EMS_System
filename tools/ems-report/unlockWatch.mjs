/**
 * 常駐監看線上解鎖工單：**有人在網頁上掛新的申請，就立刻處理**。
 *
 * 與一次性的 `unlock-online` 差在「不結束」：登入一次之後就一直開著，
 * 每隔一段時間問雲端有沒有新工單，有就馬上做。
 *
 * ⚠ 這**不是繞過驗證碼**。驗證碼仍然由使用者本人輸入過一次，
 *   之後只是**不讓那次登入過期**——等同你自己開著分頁不關。
 *   真的被伺服器踢掉時，會停下來請本人再輸入一次，絕不自動辨識（見 TOOLS_SPEC 0.3）。
 *
 * 能這樣做的前提是該系統採**閒置逾時**（使用者 2026-08-06 判斷），
 * 因此定期做一次無害的切頁就能續命。若實際上有絕對上限，掉線時會照樣要求重新登入，
 * 程式不會因此壞掉，只是要多打幾次驗證碼——所以這個設計不賭那個前提。
 */
import { UNLOCK } from './config.mjs';
import { log } from './logger.mjs';
import { gotoRecordQuery } from './navigation.mjs';
import { ensureSignedIn, isSignedIn } from './session.mjs';
import { runUnlockFlow, printUnlockSummary } from './unlock.mjs';
import { fetchPendingRequests, markRunning, resetToPending, saveResult } from './unlockQueue.mjs';
import { maskCode } from './sheetFields.mjs';

/** 把毫秒說成人話（給「已連續登入多久」用）。 */
function describeDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} 分鐘`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
}

/** HH:mm，讓畫面上每一行看得出是什麼時候發生的。 */
function clock(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 心跳：做一次無害的切頁，讓伺服器知道這個 session 還有人在用。
 *
 * 用「切到救護紀錄表查詢頁」而不是重新整理：這是流程本來就會走的動作，
 * 對系統來說跟平常操作沒有兩樣，也不會送出任何查詢或改動任何資料。
 *
 * @returns {Promise<boolean>} 心跳之後是否仍在登入狀態
 */
async function heartbeat(session) {
  try {
    await gotoRecordQuery(session.page);
  } catch (error) {
    // 切頁失敗多半就是被踢回登入頁了，交給下面的檢查判定。
    log.info(`心跳時切頁沒成功（${error instanceof Error ? error.message : error}），檢查是否還登入著`);
  }
  return isSignedIn(session.page);
}

/**
 * 處理一批工單，逐筆回寫。
 *
 * **掉線時不可以把案件寫成失敗**：那種「查無案件」是因為根本沒登入，
 * 不是案件真的有問題。這種情況把工單退回「待處理」，下一輪重新登入後再跑。
 *
 * @returns {Promise<{done: number, requeued: number}>}
 */
async function processBatch(session, queue, requests) {
  let requeued = 0;
  const outcomes = await runUnlockFlow(session, {
    temsisList: requests.map((request) => request.temsis),
    range: session.range,
    dryRun: false,
    onCaseStart: (_temsis, index) => markRunning(queue, requests[index].id),
    onCaseDone: async (outcome, index) => {
      // 只有「看起來失敗」時才多花一次檢查，成功的案件不必浪費時間。
      if (outcome.status !== '已解鎖' && outcome.status !== '無需處理') {
        if (!(await isSignedIn(session.page))) {
          log.warn(`　登入已掉線，這一筆沒有真的處理到，退回待處理：${maskCode(outcome.temsis)}`);
          await resetToPending(queue, requests[index].id);
          requeued += 1;
          return;
        }
      }
      await saveResult(queue, requests[index].id, outcome);
    },
  });
  printUnlockSummary(outcomes, { dryRun: false });
  return { done: outcomes.length - requeued, requeued };
}

/**
 * 監看主迴圈（**不會自己結束**，關掉視窗或按 Ctrl+C 才停）。
 *
 * @param {import('./session.mjs').EmsSession & {range: object}} session
 *   已登入的工作階段，另外掛上解鎖要用的查詢期間
 * @param {import('./unlockQueue.mjs').QueueSession} queue
 * @param {{dryRun: boolean, shouldStop: () => boolean}} options
 *   `dryRun`＝true 時只監看與心跳、不解鎖也不回寫
 *   （這正好可以拿來實測「登入到底能撐多久」）
 * @param {{fetchPending?: Function, processBatch?: Function, heartbeat?: Function,
 *   ensureSignedIn?: Function}} [deps]
 *   碰外部世界的四件事都可以換成替身，測試才跑得起來
 *   （比照 `locateUnlockTarget` 的既有作法）。
 */
export async function runUnlockWatch(session, queue, options, deps = {}) {
  const fetchPending = deps.fetchPending ?? fetchPendingRequests;
  const runBatch = deps.processBatch ?? processBatch;
  const beat = deps.heartbeat ?? heartbeat;
  const ensureLogin = deps.ensureSignedIn ?? ensureSignedIn;
  const { pollMs, heartbeatMs, statusEveryMs } = UNLOCK.watch;
  const startedAt = Date.now();
  let lastHeartbeat = Date.now();
  let lastStatus = Date.now();
  let handled = 0;

  log.step('進入常駐監看');
  log.info(`每 ${pollMs / 1000} 秒查一次有沒有新工單；每 ${heartbeatMs / 60000} 分鐘維持一次登入。`);
  if (options.dryRun) {
    log.warn('本次為試跑：只監看與維持登入，**不會解鎖也不會回寫**。');
    log.info('（拿它放著跑就能看出登入到底能撐多久——掉線時畫面上會出現重新登入的提示。）');
  } else {
    log.info('有人在網頁上送出申請後，最慢一輪就會被處理，不需要你再做任何事。');
  }
  log.info('要結束請直接關掉這個視窗，或按 Ctrl+C。');

  while (!options.shouldStop()) {
    const requests = await fetchPending(queue).catch((error) => {
      // 雲端讀不到多半是網路暫時斷了，不該讓整個監看死掉。
      log.warn(`[${clock()}] 查不到雲端工單（下一輪再試）：${error.message}`);
      return [];
    });

    if (requests.length > 0) {
      log.step(`[${clock()}] 收到 ${requests.length} 筆新工單`);
      for (const [position, request] of requests.entries()) {
        log.info(
          `  ${position + 1}. ${maskCode(request.temsis)}　`
            + `${request.requestedByName || '（未記錄申請人）'}　${request.reason || '（沒填事由）'}`,
        );
      }
      if (options.dryRun) {
        log.warn('　試跑模式：不處理這幾筆，它們會留在「待處理」。');
      } else {
        // 動手之前先確認還登入著，免得整批被寫成失敗。
        await ensureLogin(session);
        const result = await runBatch(session, queue, requests);
        handled += result.done;
        lastHeartbeat = Date.now(); // 剛剛才操作過系統，心跳時間重算
        if (result.requeued > 0) {
          log.warn(`有 ${result.requeued} 筆因為掉線沒處理到，已退回待處理，下一輪會再跑。`);
        }
      }
    }

    if (Date.now() - lastHeartbeat >= heartbeatMs) {
      const alive = await beat(session);
      lastHeartbeat = Date.now();
      if (!alive) {
        log.warn(`[${clock()}] 登入已被伺服器結束（連續登入了 ${describeDuration(Date.now() - startedAt)}）。`);
        await ensureLogin(session);
      }
    }

    if (Date.now() - lastStatus >= statusEveryMs) {
      lastStatus = Date.now();
      log.info(
        `[${clock()}] 監看中｜已連續登入 ${describeDuration(Date.now() - startedAt)}`
          + `｜這次已處理 ${handled} 筆`,
      );
    }

    await session.page.waitForTimeout(pollMs).catch(() => {});
  }

  log.step('收到結束指示，停止監看');
  log.info(`這次總共處理了 ${handled} 筆，連續登入 ${describeDuration(Date.now() - startedAt)}。`);
}
