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
 * 在內容框「目前這份文件」上蓋一個記號。
 *
 * 為什麼需要：這套系統的網址常常在換頁前後**一模一樣**（POST 換頁），
 * 而點選單回到同一個功能時網址更是完全不變。只看網址判斷「到了沒」，
 * 會在點下去的**那一瞬間**就認定已經到了——但新頁面其實還在路上。
 * 記號則不會騙人：新文件的 `window` 是全新的，一定沒有這個記號。
 *
 * @returns {Promise<string>} 這次用的記號
 */
async function stampContent(page) {
  const stamp = `ems-nav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await getFrame(page, SITE.frames.content)
    .evaluate((value) => {
      window.__emsNavStamp = value;
    }, stamp)
    .catch(() => {
      // 蓋不上去（例如文件正在換）只會讓下面的等待提早成立，不影響正確性。
    });
  return stamp;
}

/**
 * 等內容框真的換成**另一份文件**。
 *
 * 判定只認一件事：記號不見了。換頁進行到一半時執行環境會被銷毀，
 * `evaluate` 這時會拋錯——那代表「還在換」，不是「換好了」，必須繼續等，
 * 否則又會退回舊版那種「太早往下做」的毛病。
 *
 * @returns {Promise<boolean>} 期限內是否確實換過文件
 */
async function waitForContentReplaced(page, stamp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = page.frames().find((item) => item.name() === SITE.frames.content);
    // undefined＝讀不到（正在換頁），null＝讀得到但沒有記號（已是新文件）。
    const current = content
      ? await content.evaluate(() => window.__emsNavStamp ?? null).catch(() => undefined)
      : undefined;
    if (current === null) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * 等救護紀錄表查詢頁「可以開始填了」。
 *
 * 用查詢條件欄位是否存在來判定，而不是網址或載入事件：真正要緊的是
 * 「等一下要填的欄位在不在」，這才是後續步驟唯一依賴的東西。
 */
async function waitForQueryFormReady(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = page.frames().find((item) => item.name() === SITE.frames.content);
    const found = content
      ? await content.locator(SITE.queryFields.dateFrom).count().catch(() => 0)
      : 0;
    if (found > 0) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * 點左側選單的「救護紀錄表查詢」，並確認內容框確實換了一份新文件。
 * @returns {Promise<string|null>} 成功時回傳路徑描述，沒點到或沒換頁時回傳 null
 */
async function clickRecordQueryMenu(page) {
  const stamp = await stampContent(page);
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
  if (!clicked) return null;
  if (!(await waitForContentReplaced(page, stamp))) return null;
  return (await waitForContentAp(page, SITE.apNames.recordQuery)) ? '左側選單連結' : null;
}

/**
 * 導向「報表系統 → 救護紀錄表查詢」，並確保查詢表單真的可以開始填了。
 *
 * 主要路徑：觸發左側選單那個連結（走系統自己的導航流程）。
 * 注意：上方 header 那排報表連結要進入報表系統後才會出現，登入直後並不存在，不可用來導航。
 * 備援路徑：直接把內容框導到該功能的網址。
 *
 * ⚠ 這裡**一定要等到新頁面真的到位才回傳**（2026-08-09 踩到）：舊版只比對網址，
 * 而內容框當下的網址本來就已經是這個功能，於是點完選單 0.05 秒就宣告「到了」。
 * 接著填進去的查詢期間與 TEMSIS，全被隨後才抵達的新頁面洗掉，
 * 等於用一張空白表單去查詢——畫面上看起來就是「這個案件查無資料」。
 *
 * @param {{formReadyTimeoutMs?: number}} [options] 等查詢欄位出現的上限（毫秒）
 * @returns {Promise<string>} 實際使用的路徑描述
 */
export async function gotoRecordQuery(page, options = {}) {
  let route = await clickRecordQueryMenu(page);
  if (!route) {
    log.warn('點選單沒有成功切換，改用直接載入網址的備援方式');
    const content = getFrame(page, SITE.frames.content);
    await content.goto(SITE.contentUrl(SITE.apNames.recordQuery), { waitUntil: 'domcontentloaded' });
    if (!(await waitForContentAp(page, SITE.apNames.recordQuery))) {
      throw new Error('選單與直接載入網址都無法開啟救護紀錄表查詢頁');
    }
    route = '直接載入網址（備援）';
  }

  if (!(await waitForQueryFormReady(page, options.formReadyTimeoutMs))) {
    throw new Error(
      `已切到救護紀錄表查詢（${route}），但查詢條件欄位 ${SITE.queryFields.dateFrom} 一直沒出現，`
        + '不敢在這種狀態下填條件查詢（填了也會被還沒載完的頁面洗掉）。',
    );
  }
  return route;
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
  const stamp = await stampContent(page);
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

  // 這套系統以 POST 換頁，網址有時不變，所以不能靠網址判斷「換好了沒」，
  // 改認「內容框換成另一份文件」（見 `waitForContentReplaced`）。
  if (!(await waitForContentReplaced(page, stamp, options.timeoutMs ?? 20000))) {
    log.warn(`點了選單「${menuText}」，但內容框看起來沒有換頁；仍照原步驟往下做`);
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
