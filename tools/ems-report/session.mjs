/**
 * 瀏覽器工作階段：開站、協助登入、等待登入完成。
 *
 * 設計取捨：驗證碼一律由「使用者本人」在瀏覽器辨識輸入，
 * 本工具不做驗證碼自動辨識——那等於繞過系統的防自動化機制。
 * 帳號密碼為選填，只是省去每次打字，沒設定就整段自己手動輸入即可。
 *
 * 為了不必每一輪都重打驗證碼，**本人登入成功後的工作階段會存起來**，
 * 下一輪直接沿用（見 `SESSION_STATE`）。這是沿用自己已經解過的登入結果，
 * 不是繞過驗證碼；沿用失敗一律安靜地退回正常登入流程。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  BROWSER,
  SITE,
  LOGIN_TIMEOUT_MS,
  APP_READY_TIMEOUT_MS,
  SESSION_STATE,
  PATHS,
} from './config.mjs';
import { log, maskAccount, prompt } from './logger.mjs';

/**
 * @typedef {Object} EmsSession
 * @property {import('playwright-core').Browser} browser
 * @property {import('playwright-core').BrowserContext} context 含所有分頁與彈出式視窗
 * @property {import('playwright-core').Page} page 登入所在的主視窗
 * @property {() => Promise<void>} close
 */

/** 從 tools/ems-report/.env 讀取選填帳密（該檔已被 .gitignore 排除）。 */
function loadCredentials() {
  try {
    process.loadEnvFile(path.join(PATHS.toolDir, '.env'));
  } catch {
    // 沒有 .env 是正常情況：代表使用者選擇全手動輸入。
  }
  return {
    username: process.env.EMS_USERNAME ?? '',
    password: process.env.EMS_PASSWORD ?? '',
  };
}

/**
 * 讀取上次保存的登入狀態；沒有、過期或內容毀損時回傳 null（代表要正常登入）。
 *
 * @param {string} [filePath]
 * @param {number} [maxAgeMs]
 * @returns {Promise<object|null>}
 */
export async function loadSessionState(filePath = SESSION_STATE.file, maxAgeMs = SESSION_STATE.maxAgeMs) {
  let raw;
  try {
    const stat = await fs.stat(filePath);
    if (Date.now() - stat.mtimeMs > maxAgeMs) {
      log.info(`上次的登入狀態已超過 ${Math.round(maxAgeMs / 3600000)} 小時，不沿用，改為重新登入`);
      return null;
    }
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    // 檔案不存在（第一次跑、或剛清掉）是正常情況，不必吵。
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    log.warn('保存的登入狀態讀不懂（檔案可能毀損），改為重新登入');
    return null;
  }
}

/**
 * 保存目前的登入狀態。
 * ⚠ 內容等同登入憑證，只寫到 `.auth/`（已 gitignore），絕不可放進 out/ 或版控。
 */
export async function saveSessionState(context, filePath = SESSION_STATE.file) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await context.storageState({ path: filePath });
}

/** 刪除保存的登入狀態（檔案不存在也不會出錯）。 */
export async function clearSessionState(filePath = SESSION_STATE.file) {
  await fs.rm(filePath, { force: true });
}

/**
 * 目前還是登入狀態嗎（以「畫面上有沒有登入表單」判定）。
 *
 * ⚠ 這只看**畫面**，不代表伺服器那邊的 session 還活著。
 * 要真的確認，得先做一次會碰到伺服器的動作（例如切一次頁），
 * 逾時的話伺服器會把畫面換回登入頁，這時這個函式才會回 false。
 * 常駐監看就是這樣用的（見 `unlockWatch.mjs` 的心跳）。
 */
export async function isSignedIn(page) {
  return !(await isLoginPageVisible(page).catch(() => true));
}

/** 登入頁是否仍顯示（以驗證碼欄位是否存在判定）。 */
async function isLoginPageVisible(page) {
  for (const frame of page.frames()) {
    const count = await frame.locator(SITE.loginFields.captcha).count().catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

/**
 * 若登入表單在畫面上且帳密欄位是空的，代填帳號密碼（驗證碼留給使用者）。
 *
 * **只在欄位空白時才動作**，這點很重要：等待登入的迴圈每秒會呼叫一次，
 * 若每次都重填並把游標移到驗證碼欄，使用者打驗證碼時焦點會被不斷搶走而無法輸入。
 * 欄位一旦有值就完全不再碰，登入失敗退回空白表單時才會再填一次。
 *
 * @returns {Promise<boolean>} 這次是否真的填了
 */
async function fillCredentialsIfPresent(page, credentials) {
  if (!credentials.username && !credentials.password) return false;
  for (const frame of page.frames()) {
    const hasForm = await frame.locator(SITE.loginFields.captcha).count().catch(() => 0);
    if (!hasForm) continue;

    const currentUsername = await frame.inputValue(SITE.loginFields.username).catch(() => '');
    const currentPassword = await frame.inputValue(SITE.loginFields.password).catch(() => '');
    if (currentUsername || currentPassword) return false; // 已有內容，不干擾使用者輸入

    if (credentials.username) {
      await frame.fill(SITE.loginFields.username, credentials.username).catch(() => {});
    }
    if (credentials.password) {
      await frame.fill(SITE.loginFields.password, credentials.password).catch(() => {});
    }
    // 只在剛填完的這一次把游標移到驗證碼欄，之後不再改變焦點。
    await frame.focus(SITE.loginFields.captcha).catch(() => {});
    return true;
  }
  return false;
}

/**
 * 輪詢等待登入完成（登入頁消失即視為成功）。
 * @param {number} [timeoutMs] 等多久放棄；常駐監看會給比較短的值並自己重試。
 */
async function waitForLogin(page, credentials, timeoutMs = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isLoginPageVisible(page))) return;
    await page.waitForTimeout(1000);
    // 驗證碼打錯會退回登入頁（欄位變空白），此時才會再補一次帳密。
    const refilled = await fillCredentialsIfPresent(page, credentials).catch(() => false);
    if (refilled) log.info('偵測到登入表單重新出現，已再次代填帳號密碼');
  }
  throw new Error(`超過 ${Math.round(timeoutMs / 60000)} 分鐘仍未完成登入`);
}

/**
 * 等待登入後的主畫面（frameset）真正建好。
 *
 * 「登入頁消失」只代表表單送出了，此時系統還在組主畫面，
 * 各個 frame 尚未存在。少了這段等待，後續找 frame 會立刻失敗。
 */
export async function waitForAppReady(page, timeoutMs = APP_READY_TIMEOUT_MS) {
  const required = [SITE.frames.sideMenu, SITE.frames.content];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frameNames = page.frames().map((frame) => frame.name());
    if (required.every((name) => frameNames.includes(name))) return;
    await page.waitForTimeout(500);
  }
  const found = page.frames().map((frame) => frame.name() || '(主文件)').join('、');
  throw new Error(
    `登入後等待系統主畫面載入逾時（${timeoutMs / 1000} 秒）。` +
      `需要的 frame：${required.join('、')}；目前只有：${found}`,
  );
}

/**
 * 啟動本機已安裝的瀏覽器（不另外下載 Chromium）。
 *
 * 依序嘗試 Chrome 與 Edge：公家電腦不一定裝了 Chrome，但幾乎必有 Edge，
 * 兩者同為 Chromium 核心，操作方式完全相同。
 *
 * @returns {Promise<import('playwright-core').Browser>}
 */
async function launchBrowser() {
  const failures = [];
  for (const channel of BROWSER.channels) {
    try {
      const browser = await chromium.launch({
        channel,
        headless: BROWSER.headless,
        slowMo: BROWSER.slowMo,
      });
      log.info(`使用瀏覽器：${channel}`);
      return browser;
    } catch (error) {
      failures.push(`${channel}（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）`);
    }
  }
  throw new Error(`這台電腦找不到可用的瀏覽器，依序試過：${failures.join('、')}`);
}

/**
 * 試著沿用已帶入的登入狀態：登入頁沒出現，且主畫面確實建得起來才算成功。
 *
 * 只要有任何一點不對就回傳 false 讓呼叫端改走正常登入——
 * 這裡是「試探」而不是「確保」，失敗是預期中的正常情形，不該讓整個流程中斷。
 *
 * @returns {Promise<boolean>}
 */
export async function tryReuseSession(page, timeoutMs = SESSION_STATE.reuseReadyTimeoutMs) {
  if (await isLoginPageVisible(page).catch(() => true)) return false;
  try {
    await waitForAppReady(page, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** 引導使用者本人完成登入（帳密可代填，驗證碼一律本人輸入）。 */
async function performLogin(page, credentials, timeoutMs) {
  await fillCredentialsIfPresent(page, credentials);
  log.info(`帳號：${maskAccount(credentials.username)}${credentials.username ? '（已自 .env 代填）' : '（請自行輸入）'}`);
  log.warn('請在剛開啟的瀏覽器視窗完成登入：輸入驗證碼後按下登入按鈕。');
  log.info('（驗證碼不做自動辨識，必須由你本人輸入）');

  await waitForLogin(page, credentials, timeoutMs);
  log.ok('登入完成，等待系統主畫面載入');
  await waitForAppReady(page);
}

/**
 * 開啟瀏覽器並完成登入，回傳可繼續操作的工作階段。
 *
 * @param {{ freshLogin?: boolean }} [options] `freshLogin` 為真時捨棄保存的登入狀態，強制重新登入。
 * @returns {Promise<EmsSession>}
 */
export async function startSession(options = {}) {
  const credentials = loadCredentials();
  log.step('啟動瀏覽器（使用本機已安裝的 Chrome 或 Edge）');
  const browser = await launchBrowser();

  if (options.freshLogin) {
    await clearSessionState().catch(() => {});
    log.info('依 --fresh-login 捨棄保存的登入狀態，這次重新登入');
  }
  // ⚠ 瀏覽器已經開起來了，**從這裡開始的任何失敗都必須自己收拾**。
  //   不收的話：登入逾時（最常見）時錯誤往外拋，而呼叫端的 `withSession`
  //   是在 try 之外呼叫 startSession 的，它的 finally 根本不會執行——
  //   結果就是 Chrome 一直開著、node 程序也不會結束（2026-08-05 實際踩到，
  //   使用者的機器上留了兩個殭屍程序）。
  let context;
  try {
    const savedState = options.freshLogin ? null : await loadSessionState();
    context = await browser.newContext({
      viewport: BROWSER.viewport,
      acceptDownloads: true,
      ...(savedState ? { storageState: savedState } : {}),
    });
    const page = await context.newPage();

    log.step('開啟緊急救護管理系統');
    await page.goto(SITE.entryUrl, { waitUntil: 'domcontentloaded' });

    if (savedState && (await tryReuseSession(page))) {
      log.ok('沿用上次的登入狀態，這次不用再輸入驗證碼');
    } else {
      if (savedState) {
        log.info('上次的登入狀態已失效（多半是伺服器端逾時），改為重新登入');
        await clearSessionState().catch(() => {});
        await page.goto(SITE.entryUrl, { waitUntil: 'domcontentloaded' });
      }
      await performLogin(page, credentials);
      await saveSessionState(context).catch((error) => {
        // 存不起來只是下次要重打驗證碼，不影響這一輪，不該讓流程掛掉。
        log.warn(`登入狀態保存失敗（下次仍需重新登入）：${error instanceof Error ? error.message : String(error)}`);
      });
      log.info('已保存登入狀態，短時間內再跑一次就不必重打驗證碼');
    }
    log.ok('主畫面已就緒');
    return buildSession(browser, context, page);
  } catch (error) {
    log.info('登入未完成，關閉瀏覽器');
    await browser.close().catch(() => {});
    throw error;
  }
}

/**
 * 確認還登入著；掉線的話**在同一個瀏覽器視窗**請使用者重新登入。
 *
 * 給常駐監看用：session 被伺服器踢掉時不必整個重開，把畫面導回入口、
 * 代填帳密、等使用者本人輸入驗證碼即可，其餘流程完全不受影響。
 *
 * 刻意沿用 `performLogin`：驗證碼一律由本人輸入這件事只有一個實作，
 * 不會因為多開一條路而被繞過。
 *
 * @param {EmsSession} session
 * @param {{timeoutMs?: number}} [options] 等待使用者登入的上限
 * @returns {Promise<'已登入'|'重新登入'|'等不到'>}
 *   `等不到`＝時間內沒人來登入。**這不是致命錯誤**：常駐監看會保持執行、
 *   下一輪再等一次（2026-08-06 實際踩到——凌晨掉線時使用者在睡覺，
 *   舊版等 10 分鐘就讓整個監看結束，早上看到的是一個已經死掉的視窗）。
 */
export async function ensureSignedIn(session, options = {}) {
  if (await isSignedIn(session.page)) return '已登入';

  log.warn('登入已失效（伺服器端逾時），需要重新登入一次。');
  await session.page.goto(SITE.entryUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  try {
    await performLogin(session.page, loadCredentials(), options.timeoutMs);
  } catch (error) {
    log.warn(`這段時間內沒有完成登入：${error instanceof Error ? error.message : error}`);
    return '等不到';
  }
  await saveSessionState(session.context).catch(() => {});
  log.ok('已重新登入');
  return '重新登入';
}

/**
 * 組出工作階段物件。
 * @returns {EmsSession}
 */
function buildSession(browser, context, page) {
  return {
    browser,
    context,
    page,
    close: async () => {
      // 關閉前再存一次：cookie 可能在這一輪被伺服器換過，存最新的才有意義。
      await saveSessionState(context).catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

export { prompt };
