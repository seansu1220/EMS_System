/**
 * 系統內的導航共用邏輯（探測模式與正式流程都用這裡）。
 *
 * 這個系統登入後是 frameset 版面，且全站以 POST 導頁，
 * 因此 frame 物件會在每次導航後重建，取用前一律重新查找，不可快取。
 */
import { SITE } from './config.mjs';
import { log } from './logger.mjs';

/** 依名稱取得 frame；找不到即拋出可讀的錯誤。 */
export function getFrame(page, frameName) {
  const frame = page.frames().find((item) => item.name() === frameName);
  if (!frame) throw new Error(`找不到名為 ${frameName} 的 frame，系統版面可能已改版`);
  return frame;
}

/** 等待內容框載入指定功能，回傳是否成功。 */
export async function waitForContentAp(page, apName, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = page.frames().find((item) => item.name() === SITE.frames.content);
    if (content?.url().includes(apName)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * 導向「報表系統 → 救護紀錄表查詢」。
 *
 * 主要路徑：觸發左側選單那個連結（走系統自己的導航流程）。
 * 注意：上方 header 那排報表連結要進入報表系統後才會出現，登入直後並不存在，不可用來導航。
 * 備援路徑：直接把內容框導到該功能的網址。
 *
 * @returns {Promise<string>} 實際使用的路徑描述
 */
export async function gotoRecordQuery(page) {
  const sideMenu = getFrame(page, SITE.frames.sideMenu);
  // 選單可能是收合狀態，用 JS 觸發而非 Playwright 點擊，才不會因為元素不可見而失敗。
  const clicked = await sideMenu.evaluate((menuText) => {
    const link = [...document.querySelectorAll('a')].find(
      (item) => item.textContent.trim() === menuText,
    );
    if (!link) return false;
    link.click();
    return true;
  }, SITE.menu.recordQuery);

  if (clicked && (await waitForContentAp(page, SITE.apNames.recordQuery))) {
    return '左側選單連結';
  }

  log.warn('點選單沒有成功切換，改用直接載入網址的備援方式');
  const content = getFrame(page, SITE.frames.content);
  await content.goto(SITE.contentUrl(SITE.apNames.recordQuery), { waitUntil: 'domcontentloaded' });
  if (!(await waitForContentAp(page, SITE.apNames.recordQuery))) {
    throw new Error('選單與直接載入網址都無法開啟救護紀錄表查詢頁');
  }
  return '直接載入網址（備援）';
}

/**
 * 列出左側選單所有可點的項目文字。
 *
 * 用途：導航失敗時把「實際有哪些項目」寫進錯誤訊息，不必請使用者回報畫面。
 * 選單項目是系統功能名稱，不含個人資料。
 *
 * @returns {Promise<string[]>}
 */
export async function listMenuItems(page) {
  const sideMenu = getFrame(page, SITE.frames.sideMenu);
  return sideMenu
    .evaluate(() =>
      [...document.querySelectorAll('a')]
        .map((link) => (link.textContent || '').replace(/\s+/g, '').trim())
        .filter(Boolean),
    )
    .catch(() => []);
}

/**
 * 點左側選單的某個項目並等待內容框換頁。
 *
 * 用 JS 觸發而非 Playwright 點擊：選單可能是收合狀態，元素不可見時 Playwright 會拒絕點擊。
 * 比對先求精確相等，沒有才退回「包含」，避免「案件列表」誤點到「案件列表統計」之類的項目。
 *
 * @param {import('playwright-core').Page} page
 * @param {string} menuText 選單文字
 * @param {{settleMs?: number, timeoutMs?: number}} [options]
 * @returns {Promise<void>}
 */
export async function gotoMenuItem(page, menuText, options = {}) {
  const urlBefore = getFrame(page, SITE.frames.content).url();
  const sideMenu = getFrame(page, SITE.frames.sideMenu);
  const clicked = await sideMenu.evaluate((text) => {
    const links = [...document.querySelectorAll('a')];
    const normalize = (value) => (value || '').replace(/\s+/g, '').trim();
    const target =
      links.find((link) => normalize(link.textContent) === text)
      ?? links.find((link) => normalize(link.textContent).includes(text));
    if (!target) return false;
    target.click();
    return true;
  }, menuText);

  if (!clicked) {
    const available = await listMenuItems(page);
    throw new Error(
      `左側選單找不到「${menuText}」。目前選單項目：${available.join('、') || '(讀不到)'}`,
    );
  }

  // 這套系統以 POST 換頁，網址有時不變，因此「網址改變」與「載入完成」兩者取其一即可。
  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  while (Date.now() < deadline) {
    const current = page.frames().find((frame) => frame.name() === SITE.frames.content);
    if (current && current.url() !== urlBefore) break;
    await page.waitForTimeout(500);
  }
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(options.settleMs ?? SITE.querySettleMs);
}

/** 呼叫頁面上的展開函式（進階搜尋區塊）。 */
async function callToggle(frame, toggleFnName) {
  return frame.evaluate((fnName) => {
    const toggleFn = window[fnName];
    if (typeof toggleFn !== 'function') return false;
    toggleFn();
    return true;
  }, toggleFnName);
}

/** 展開兩個進階搜尋區塊（探測用，單純各觸發一次）。 */
export async function toggleAdvancedSearch(page) {
  const content = getFrame(page, SITE.frames.content);
  const results = [];
  for (const toggleFnName of SITE.advancedSearchToggles) {
    const ok = await callToggle(content, toggleFnName);
    results.push(`${toggleFnName}=${ok ? '成功' : '找不到此函式'}`);
    await page.waitForTimeout(800);
  }
  return results.join('、');
}

/**
 * 確保指定欄位可見（必要時展開進階搜尋）。
 *
 * 用「檢查可見性」而非盲目切換，因為展開函式是 toggle，
 * 盲目呼叫兩次反而會把已展開的區塊收起來。
 *
 * @param {import('playwright-core').Page} page
 * @param {string} selector 需要可見的欄位
 * @returns {Promise<void>}
 */
export async function ensureFieldVisible(page, selector) {
  const isVisible = async () => {
    const content = getFrame(page, SITE.frames.content);
    return content.locator(selector).isVisible().catch(() => false);
  };
  if (await isVisible()) return;

  for (const toggleFnName of SITE.advancedSearchToggles) {
    await callToggle(getFrame(page, SITE.frames.content), toggleFnName);
    await page.waitForTimeout(600);
    if (await isVisible()) return;
  }
  throw new Error(`展開進階搜尋後仍找不到可見的欄位 ${selector}，系統版面可能已改版`);
}
