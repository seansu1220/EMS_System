/**
 * 瀏覽器工作階段：開站、協助登入、等待登入完成。
 *
 * 設計取捨：驗證碼一律由「使用者本人」在瀏覽器辨識輸入，
 * 本工具不做驗證碼自動辨識——那等於繞過系統的防自動化機制。
 * 帳號密碼為選填，只是省去每次打字，沒設定就整段自己手動輸入即可。
 */
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BROWSER, SITE, LOGIN_TIMEOUT_MS, PATHS } from './config.mjs';
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

/** 登入頁是否仍顯示（以驗證碼欄位是否存在判定）。 */
async function isLoginPageVisible(page) {
  for (const frame of page.frames()) {
    const count = await frame.locator(SITE.loginFields.captcha).count().catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

/** 若登入表單在畫面上，代填帳號密碼（驗證碼留給使用者）。 */
async function fillCredentialsIfPresent(page, credentials) {
  if (!credentials.username && !credentials.password) return;
  for (const frame of page.frames()) {
    const hasForm = await frame.locator(SITE.loginFields.captcha).count().catch(() => 0);
    if (!hasForm) continue;
    if (credentials.username) {
      await frame.fill(SITE.loginFields.username, credentials.username).catch(() => {});
    }
    if (credentials.password) {
      await frame.fill(SITE.loginFields.password, credentials.password).catch(() => {});
    }
    await frame.focus(SITE.loginFields.captcha).catch(() => {});
    return;
  }
}

/** 輪詢等待登入完成（登入頁消失即視為成功）。 */
async function waitForLogin(page, credentials) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isLoginPageVisible(page))) return;
    await page.waitForTimeout(1000);
    // 驗證碼打錯會退回登入頁，這裡順手把帳密再補上。
    await fillCredentialsIfPresent(page, credentials).catch(() => {});
  }
  throw new Error(`超過 ${LOGIN_TIMEOUT_MS / 60000} 分鐘仍未完成登入`);
}

/**
 * 等待登入後的主畫面（frameset）真正建好。
 *
 * 「登入頁消失」只代表表單送出了，此時系統還在組主畫面，
 * 各個 frame 尚未存在。少了這段等待，後續找 frame 會立刻失敗。
 */
async function waitForAppReady(page, timeoutMs = APP_READY_TIMEOUT_MS) {
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
 * 開啟瀏覽器並完成登入，回傳可繼續操作的工作階段。
 * @returns {Promise<EmsSession>}
 */
export async function startSession() {
  const credentials = loadCredentials();
  log.step('啟動瀏覽器（使用本機 Chrome）');
  const browser = await chromium.launch({
    channel: BROWSER.channel,
    headless: BROWSER.headless,
    slowMo: BROWSER.slowMo,
  });
  const context = await browser.newContext({ viewport: BROWSER.viewport, acceptDownloads: true });
  const page = await context.newPage();

  log.step('開啟緊急救護管理系統登入頁');
  await page.goto(SITE.entryUrl, { waitUntil: 'domcontentloaded' });
  await fillCredentialsIfPresent(page, credentials);

  log.info(`帳號：${maskAccount(credentials.username)}${credentials.username ? '（已自 .env 代填）' : '（請自行輸入）'}`);
  log.warn('請在剛開啟的瀏覽器視窗完成登入：輸入驗證碼後按下登入按鈕。');
  log.info('（驗證碼不做自動辨識，必須由你本人輸入）');

  await waitForLogin(page, credentials);
  log.ok('登入完成，等待系統主畫面載入');
  await waitForAppReady(page);
  log.ok('主畫面已就緒');

  return {
    browser,
    context,
    page,
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

export { prompt };
