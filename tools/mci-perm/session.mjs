/**
 * 瀏覽器工作階段：開站、協助登入、等待登入完成。
 *
 * 設計取捨（與 tools/ems-report 相同，不因換一個系統就放寬）：
 * **驗證碼一律由使用者本人在瀏覽器辨識輸入**，本工具不做自動辨識、不接第三方辨識服務——
 * 那等於繞過來源系統的防自動化機制。帳號密碼可由 .env 代填，只是省去每次打字。
 *
 * 為了不必每一輪都重打驗證碼，瀏覽器用**固定的使用者資料夾**（見 `SESSION_STATE`），
 * 等同「同一台電腦上的同一個 Chrome」，登入狀態留在磁碟上，下次直接接續。
 * 這是沿用自己已經解過的登入結果，不是繞過驗證碼；沿用失敗一律安靜地退回正常登入。
 *
 * ⚠ 原本的作法是把 cookie 存成 json 再灌進全新的瀏覽器，**實測完全沒用**：
 *   隔 9 分鐘這個 SSO 就要求重新登入（對它來說每次都是一台陌生機器）。
 *
 * 一次登入可以跑完整份名單——這仍然是「不用一直打驗證碼」的主力。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BROWSER, SITE, SESSION_STATE, PATHS, LOGIN_TIMEOUT_MS, APP_READY_TIMEOUT_MS } from './config.mjs';
import { findClickables, findLoginFields, selectOptionAnywhere } from './domFind.mjs';
import { log, maskAccount } from './logger.mjs';

/**
 * @typedef {Object} PermSession
 * @property {import('playwright-core').Browser} browser
 * @property {import('playwright-core').BrowserContext} context
 * @property {import('playwright-core').Page} page 登入所在的主視窗
 * @property {() => Promise<void>} close
 */

/**
 * 從 tools/mci-perm/.env 讀取設定（該檔已被 .gitignore 排除）。
 *
 * ⚠ 這是**另一個系統**的帳密，與 tools/ems-report/.env 的 EMS_USERNAME 無關，
 *   兩邊各讀各的檔案，不會互相影響。
 */
export function loadSettings() {
  try {
    process.loadEnvFile(path.join(PATHS.toolDir, '.env'));
  } catch (error) {
    // 沒有 .env 是可接受的情況：代表使用者選擇全手動輸入帳密。
    // 但網址沒設定就無法進站，那個錯誤由 SITE.entryUrl() negotiate。
  }
  return {
    username: process.env.MCI_USERNAME ?? '',
    password: process.env.MCI_PASSWORD ?? '',
    /** 預設單位：名單沒寫單位時用這個（可留空）。 */
    defaultUnit: process.env.MCI_DEFAULT_UNIT ?? '',
  };
}

/**
 * 上次用過的瀏覽器資料夾還在嗎（在的話就有機會免登入）。
 * @returns {Promise<boolean>}
 */
export async function hasSavedProfile(profileDir = SESSION_STATE.profileDir) {
  try {
    const stat = await fs.stat(profileDir);
    return stat.isDirectory();
  } catch {
    // 沒有（第一次跑、或剛清掉）是正常情況，不必吵。
    return false;
  }
}

/**
 * 丟掉保存的登入狀態（整個瀏覽器資料夾）。
 *
 * ⚠ 這個資料夾等同登入憑證，只放在 `.auth/`（已 gitignore、不打包進可攜版）。
 */
export async function clearSessionState(profileDir = SESSION_STATE.profileDir) {
  await fs.rm(profileDir, { recursive: true, force: true });
}

/**
 * 在所有 frame 裡找登入表單。
 *
 * 刻意不假設版面是不是 frameset：這個系統還沒探測過，
 * 有可能是單一頁面，也可能像救護系統那樣切成好幾個 frame。
 *
 * @returns {Promise<{frame: import('playwright-core').Frame, fields: object}|null>}
 */
export async function findLoginForm(page) {
  for (const frame of page.frames()) {
    const fields = await findLoginFields(frame, SITE.loginFields).catch(() => null);
    if (fields) return { frame, fields };
  }
  return null;
}

/** 目前還在登入頁嗎（以「畫面上有沒有密碼欄」判定）。 */
export async function isLoginPageVisible(page) {
  return (await findLoginForm(page)) !== null;
}

/** 目前還是登入狀態嗎。 */
export async function isSignedIn(page) {
  return !(await isLoginPageVisible(page).catch(() => true));
}

/**
 * 若登入表單在畫面上且帳密欄位是空的，代填帳號密碼（驗證碼留給使用者）。
 *
 * **只在欄位空白時才動作**，這點很重要：等待登入的迴圈每秒會呼叫一次，
 * 若每次都重填並把游標移到驗證碼欄，使用者打驗證碼時焦點會被不斷搶走而打不完。
 * 欄位一旦有值就完全不再碰，登入失敗退回空白表單時才會再填一次。
 *
 * @returns {Promise<boolean>} 這次是否真的填了
 */
async function fillCredentialsIfPresent(page, credentials) {
  const found = await findLoginForm(page);
  if (!found) return false;
  const { frame, fields } = found;

  // 縣市別要選「桃園市」（使用者 2026-08-18 補充的步驟）。
  // 這一步與帳密分開處理：就算沒設定帳密、全部自己打，縣市別仍然幫忙選好。
  await selectLoginCity(frame);

  if (!credentials.username && !credentials.password) return false;

  const usernameSelector = SITE.loginFields.override.username || fields.username?.selector;
  const passwordSelector = SITE.loginFields.override.password || fields.password?.selector;
  const captchaSelector = SITE.loginFields.override.captcha || fields.captcha?.selector;
  if (!usernameSelector || !passwordSelector) return false;

  const currentUsername = await frame.inputValue(usernameSelector).catch(() => '');
  const currentPassword = await frame.inputValue(passwordSelector).catch(() => '');
  if (currentUsername || currentPassword) return false; // 已有內容，不干擾使用者輸入

  if (credentials.username) await frame.fill(usernameSelector, credentials.username).catch(() => {});
  if (credentials.password) await frame.fill(passwordSelector, credentials.password).catch(() => {});
  // 只在剛填完的這一次把游標移到驗證碼欄，之後不再改變焦點。
  if (captchaSelector) await frame.focus(captchaSelector).catch(() => {});
  return true;
}

/**
 * 選好登入頁的縣市別。
 *
 * **已經選好就不再動**：使用者可能自己先選了，重選會把游標搶走。
 * 選不到不算失敗（有些登入頁沒有這一欄），只是留一句話在紀錄裡。
 *
 * @returns {Promise<boolean>} 這次是否真的選了
 */
async function selectLoginCity(frame) {
  const city = SITE.loginFields.cityValue();
  if (!city) return false;
  const current = await frame
    .evaluate((wanted) => {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.some((select) => (select.selectedOptions[0]?.textContent ?? '').includes(wanted));
    }, city)
    .catch(() => false);
  if (current) return false; // 已經是這個縣市了，不要多動

  const result = await selectOptionAnywhere(frame, [city]).catch(() => ({ ok: false, reason: '讀不到下拉' }));
  if (result.ok) {
    log.info(`縣市別：已選「${result.chosen}」`);
    return true;
  }
  log.info(`縣市別：沒有自動選到（${result.reason}），請自己選一下`);
  return false;
}

/** 輪詢等待登入完成（登入表單消失即視為成功）。 */
async function waitForLogin(page, credentials, timeoutMs = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isLoginPageVisible(page).catch(() => false))) return;
    await page.waitForTimeout(1000);
    // 驗證碼打錯會退回登入頁（欄位變空白），此時才會再補一次帳密。
    const refilled = await fillCredentialsIfPresent(page, credentials).catch(() => false);
    if (refilled) log.info('偵測到登入表單重新出現，已再次代填帳號密碼');
  }
  throw new Error(`超過 ${Math.round(timeoutMs / 60000)} 分鐘仍未完成登入`);
}

/**
 * 等登入後的主畫面真的可以操作。
 *
 * 「登入頁消失」只代表表單送出了，此時系統多半還在組主畫面。
 * 這裡等到頁面靜下來（網路閒置）或逾時為止，逾時不算失敗——
 * 有些系統會一直有背景請求，等不到 networkidle 是正常的。
 */
export async function waitForAppReady(page, timeoutMs = APP_READY_TIMEOUT_MS) {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * 用**固定的使用者資料夾**啟動本機已安裝的瀏覽器（不另外下載 Chromium）。
 *
 * 依序嘗試 Chrome 與 Edge：公家電腦不一定裝了 Chrome，但幾乎必有 Edge，
 * 兩者同為 Chromium 核心，操作方式完全相同。
 *
 * ⚠ 用 `launchPersistentContext` 而不是 `launch`：後者每次都開一個乾淨的臨時
 * profile，對 SSO 來說每次都是新機器，登入狀態一次都留不住（2026-08-18 實測，
 * 隔 9 分鐘就被要求重新登入）。固定資料夾才等同「同一個瀏覽器」。
 *
 * @returns {Promise<import('playwright-core').BrowserContext>}
 */
async function launchPersistentBrowser(profileDir) {
  await fs.mkdir(profileDir, { recursive: true });
  const failures = [];
  for (const channel of BROWSER.channels) {
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        channel,
        headless: BROWSER.headless,
        slowMo: BROWSER.slowMo,
        viewport: BROWSER.viewport,
        acceptDownloads: true,
      });
      log.info(`使用瀏覽器：${channel}（固定資料夾，登入狀態會留著）`);
      return context;
    } catch (error) {
      failures.push(`${channel}（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）`);
    }
  }
  throw new Error(
    `開不起瀏覽器，依序試過：${failures.join('、')}。` +
      '（若訊息提到資料夾被占用，代表還有另一個視窗開著，關掉再跑一次）',
  );
}

/**
 * 試著沿用已帶入的登入狀態：登入頁沒出現就算成功。
 *
 * 只要有任何一點不對就回傳 false 讓呼叫端改走正常登入——
 * 這裡是「試探」而不是「確保」，失敗是預期中的正常情形，不該讓流程中斷。
 */
export async function tryReuseSession(page, timeoutMs = SESSION_STATE.reuseReadyTimeoutMs) {
  // 這個系統登入前後是**同一個網址**：沒登入時顯示登入表單，
  // 還登入著則顯示子系統選單（右上角有「OOO，您好」）。
  // 因此以「哪一個先出現」判定——只看「有沒有登入表單」會在頁面還在渲染時誤判。
  //
  // ⚠ 已知限制：這個系統的主畫面是登入後**動態切換**出來的，重新 GET 網址一律
  //   退回登入表單。因此這個試探實務上幾乎一定回 false（見 README 的說明），
  //   真正省下驗證碼的是「一次登入把整份名單做完」。
  await page.goto(SITE.entryUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoginPageVisible(page).catch(() => false)) return false;
    const greeting = await findClickables(page.mainFrame(), SITE.flow.userMenuTexts).catch(() => []);
    if (greeting.length > 0) return true; // 招呼語出現＝還登入著
    await page.waitForTimeout(400);
  }
  return false;
}

/** 引導使用者本人完成登入（帳密可代填，驗證碼一律本人輸入）。 */
async function performLogin(page, credentials, timeoutMs) {
  const filled = await fillCredentialsIfPresent(page, credentials);
  log.info(
    `帳號：${maskAccount(credentials.username)}${
      filled ? '（已自 .env 代填）' : credentials.username ? '（.env 有設定，但這次沒填到欄位）' : '（請自行輸入）'
    }`,
  );
  log.warn('請在剛開啟的瀏覽器視窗完成登入：輸入驗證碼後按下登入按鈕。');
  log.info('（驗證碼不做自動辨識，必須由你本人輸入；登入一次就能跑完整份名單）');

  await waitForLogin(page, credentials, timeoutMs);
  log.ok('登入完成，等待系統主畫面載入');
  await waitForAppReady(page);
}

/**
 * 開啟瀏覽器並完成登入，回傳可繼續操作的工作階段。
 *
 * @param {{ freshLogin?: boolean }} [options] `freshLogin` 為真時捨棄保存的登入狀態，強制重新登入
 * @returns {Promise<PermSession>}
 */
export async function startSession(options = {}) {
  const settings = loadSettings();
  const entryUrl = SITE.entryUrl(); // 未設定網址時在開瀏覽器前就先擋下來

  if (options.freshLogin) {
    await clearSessionState().catch(() => {});
    log.info('依 --fresh-login 丟掉保存的瀏覽器資料夾，這次重新登入');
  }
  const hadProfile = await hasSavedProfile();

  log.step('啟動瀏覽器（使用本機已安裝的 Chrome 或 Edge）');
  const context = await launchPersistentBrowser(SESSION_STATE.profileDir);

  // ⚠ 瀏覽器已經開起來了，**從這裡開始的任何失敗都必須自己收拾**，
  //   否則登入逾時時錯誤往外拋，Chrome 與 node 都會留成殭屍程序。
  try {
    const page = context.pages()[0] ?? (await context.newPage());

    log.step('開啟大量傷患系統');
    // 有舊資料夾就先試探「還登入著嗎」；沒有就直接去登入頁，不必白等。
    if (hadProfile && (await tryReuseSession(page))) {
      log.ok('沿用上次的登入狀態，這次不用再輸入驗證碼');
    } else {
      if (hadProfile) log.info('上次的登入已經失效（伺服器端逾時），這次要重新登入');
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
      await performLogin(page, settings);
      log.info('登入狀態留在瀏覽器資料夾裡，接下來再跑就會直接接續');
    }
    log.ok('主畫面已就緒');
    return {
      /** persistent context 沒有獨立的 browser 物件，需要時從 context 取。 */
      browser: context.browser(),
      context,
      page,
      close: async () => {
        // 關掉 context 就等於關掉瀏覽器；登入狀態已經在磁碟上，不必另外保存。
        await context.close().catch(() => {});
      },
    };
  } catch (error) {
    log.info('登入未完成，關閉瀏覽器');
    await context.close().catch(() => {});
    throw error;
  }
}

/**
 * 確認還登入著；掉線的話**在同一個瀏覽器視窗**請使用者重新登入。
 *
 * 名單很長時中途可能被伺服器踢掉，這時不必整個重來，
 * 把畫面導回入口、代填帳密、等使用者本人輸入驗證碼即可。
 *
 * 刻意沿用 `performLogin`：驗證碼一律由本人輸入這件事只有一個實作，
 * 不會因為多開一條路而被繞過。
 *
 * @returns {Promise<'已登入'|'重新登入'|'等不到'>}
 */
export async function ensureSignedIn(session, options = {}) {
  if (await isSignedIn(session.page)) return '已登入';

  log.warn('登入已失效（伺服器端逾時），需要重新登入一次。');
  await session.page.goto(SITE.entryUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});
  try {
    await performLogin(session.page, loadSettings(), options.timeoutMs);
  } catch (error) {
    log.warn(`這段時間內沒有完成登入：${error instanceof Error ? error.message : error}`);
    return '等不到';
  }
  log.ok('已重新登入');
  return '重新登入';
}
