/**
 * 頁面結構探測 —— 讓開發者知道「這一頁有哪些欄位、按鈕、選項」，以便寫出正確的自動化選擇器。
 *
 * ⚠ 個資原則（本檔最重要的規則）：
 *   只輸出「結構」不輸出「資料」。
 *   - 文字輸入框：只記錄 id / name / type，**不記錄使用者輸入的值**
 *   - 表格：只記錄欄位標題（th），**絕不記錄任何資料列**
 *   - 可點擊元素：**跳過資料列表（列數 > DATA_TABLE_ROW_LIMIT 的表格）內的元素**，
 *     並將 5 碼以上連續數字遮蔽（案件編號、身分證、電話等），文字一律截斷
 *   - 不截圖（截圖可能拍到個案明細）
 *   下拉選單的選項（分隊名稱、救護狀態等）屬系統代碼表，非個資，故予保留。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, SITE } from './config.mjs';
import { log, prompt } from './logger.mjs';

/** 超過這個列數的表格視為「資料列表」，其內元素一律不擷取。 */
const DATA_TABLE_ROW_LIMIT = 5;

/** 在瀏覽器端執行的擷取邏輯：只取結構。 */
function extractStructure(rowLimit) {
  /** 遮蔽 5 碼以上連續數字，避免誤抓到案件編號之類的識別資料。 */
  const maskDigits = (text) => (text || '').replace(/\d{5,}/g, '#####');
  const clean = (text, max = 80) => maskDigits(text).replace(/\s+/g, ' ').trim().slice(0, max);
  /** 只有按鈕類的 value 才是標籤文字，其餘輸入值一律不取（可能是個資）。 */
  const BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'image']);
  /** 元素是否位於資料列表內。 */
  const inDataTable = (element) => {
    const table = element.closest('table');
    return Boolean(table) && table.rows.length > rowLimit;
  };

  const inputs = [...document.querySelectorAll('input, textarea')].map((element) => {
    const type = (element.getAttribute('type') || element.tagName.toLowerCase()).toLowerCase();
    return {
      type,
      id: element.id || '',
      name: element.getAttribute('name') || '',
      className: clean(element.className, 60),
      label: BUTTON_TYPES.has(type) ? clean(element.getAttribute('value'), 40) : '',
      onclick: clean(element.getAttribute('onclick'), 160),
    };
  });

  const selects = [...document.querySelectorAll('select')].map((element) => ({
    id: element.id || '',
    name: element.getAttribute('name') || '',
    options: [...element.options].map((option) => ({
      value: option.value,
      text: clean(option.textContent, 40),
    })),
  }));

  // 任何「看起來可以點」的東西：連結、圖片按鈕、帶 onclick 的區塊。
  // 舊系統常把「查詢」「匯出EXCEL」做成圖片或 div，不是標準表單元件。
  const clickableSelector = 'a, img, button, [onclick]';
  const clickables = [...document.querySelectorAll(clickableSelector)]
    .filter((element) => !inDataTable(element))
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      name: element.getAttribute('name') || '',
      className: clean(element.className, 60),
      text: clean(element.textContent, 40),
      title: clean(element.getAttribute('title'), 40),
      alt: clean(element.getAttribute('alt'), 40),
      src: clean((element.getAttribute('src') || '').split('/').pop(), 40),
      href: clean(element.getAttribute('href'), 100),
      onclick: clean(element.getAttribute('onclick'), 160),
    }))
    .filter((item) => item.text || item.onclick || item.href || item.alt || item.title || item.src);

  // 表格只取標題列，資料列一律不取。
  const tables = [...document.querySelectorAll('table')]
    .map((table, index) => ({
      index,
      id: table.id || '',
      headers: [...table.querySelectorAll('th')].map((cell) => clean(cell.textContent, 30)).filter(Boolean),
      rowCount: table.rows.length,
    }))
    .filter((table) => table.headers.length > 0);

  return { title: document.title, inputs, selects, clickables, tables };
}

/** 擷取單一分頁（含其所有 frame）的結構。 */
async function collectFrames(page) {
  const results = [];
  for (const frame of page.frames()) {
    try {
      const structure = await frame.evaluate(extractStructure, DATA_TABLE_ROW_LIMIT);
      results.push({ frameName: frame.name(), frameUrl: frame.url(), ...structure });
    } catch (error) {
      results.push({
        frameName: frame.name(),
        frameUrl: frame.url(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * 擷取瀏覽器中「所有開著的視窗／分頁」。
 * 系統若以彈出式視窗開啟功能，會成為獨立的 page，只掃主視窗會漏掉。
 */
async function collectAllPages(context) {
  const pages = [];
  for (const [index, page] of context.pages().entries()) {
    if (page.isClosed()) continue;
    pages.push({ pageIndex: index, pageUrl: page.url(), frames: await collectFrames(page) });
  }
  return pages;
}

/** 產生檔名安全的標籤。 */
function toSafeLabel(label, sequence) {
  const cleaned = label.replace(/[^\w一-龥-]/g, '_').slice(0, 40);
  return `${String(sequence).padStart(2, '0')}-${cleaned || 'page'}`;
}

/** 擷取目前狀態並存檔，回傳存檔路徑。 */
async function captureTo(context, sequence, label) {
  const pages = await collectAllPages(context);
  const filePath = path.join(PATHS.probeDir, `${toSafeLabel(label, sequence)}.json`);
  await fs.writeFile(
    filePath,
    JSON.stringify({ capturedAt: new Date().toISOString(), label, pages }, null, 2),
    'utf8',
  );
  const frameCount = pages.reduce((sum, page) => sum + page.frames.length, 0);
  log.ok(`已存出 ${path.relative(process.cwd(), filePath)}（${pages.length} 視窗 / ${frameCount} frame）`);
  return filePath;
}

/** 依名稱取得 frame；frame 會在導航後重建，故每次都重新查找。 */
function getFrame(page, frameName) {
  const frame = page.frames().find((item) => item.name() === frameName);
  if (!frame) throw new Error(`找不到名為 ${frameName} 的 frame，系統版面可能已改版`);
  return frame;
}

/** 等待內容框載入指定功能，回傳是否成功。 */
async function waitForContentAp(page, apName, timeoutMs = 20000) {
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
 * 主要路徑：直接觸發左側選單那個連結（走系統自己的導航流程）。
 * 注意：上方 header 那排報表連結要進到報表系統後才會出現，登入直後並不存在，不可用來導航。
 * 備援路徑：直接把內容框導到該功能的網址。
 * @returns {Promise<string>} 實際使用的路徑描述
 */
async function gotoRecordQuery(page) {
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

/** 展開頁面上兩個進階搜尋區塊。 */
async function expandAdvancedSearch(page) {
  const content = getFrame(page, SITE.frames.content);
  const expanded = [];
  for (const toggleFnName of SITE.advancedSearchToggles) {
    const ok = await content.evaluate((fnName) => {
      const toggleFn = window[fnName];
      if (typeof toggleFn !== 'function') return false;
      toggleFn();
      return true;
    }, toggleFnName);
    expanded.push(`${toggleFnName}=${ok ? '成功' : '找不到此函式'}`);
    await page.waitForTimeout(800);
  }
  return expanded.join('、');
}

/** 記錄所有 frame 的名稱與網址，失敗時用來判斷卡在哪裡。 */
async function describeFrames(page) {
  return page.frames().map((frame) => ({ name: frame.name(), url: frame.url() }));
}

/**
 * 自動探測：使用者只需登入，其餘導航與擷取全部自動完成。
 *
 * 每個步驟都獨立捕捉錯誤：任何一步失敗都會存下當下的畫面結構與診斷資訊再結束，
 * 這樣排查問題不必請使用者重新登入一次。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page 登入所在的主視窗
 */
export async function runAutoProbe(context, page) {
  await fs.mkdir(PATHS.probeDir, { recursive: true });
  log.step('自動探測開始（登入後就不用再操作了，交給程式）');

  /** @type {{name:string, result:string}[]} */
  const stepLog = [];
  let failure = null;

  try {
    await captureTo(context, 1, '登入後主畫面');
    stepLog.push({ name: '擷取登入後主畫面', result: '成功' });

    log.info('導向：報表系統 → 救護紀錄表查詢');
    const route = await gotoRecordQuery(page);
    stepLog.push({ name: '導向救護紀錄表查詢', result: `成功（${route}）` });
    await captureTo(context, 2, '救護紀錄表查詢-初始');

    log.info('展開「進階搜尋」與「急救處置進階搜尋」');
    const expanded = await expandAdvancedSearch(page);
    stepLog.push({ name: '展開進階搜尋', result: expanded });
    await captureTo(context, 3, '救護紀錄表查詢-已展開進階搜尋');

    log.ok('自動探測完成，可以關閉視窗了');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    log.fail('自動探測', error);
    log.info('正在存下當下畫面與診斷資訊，供後續排查（不需要你重新登入）');
    await captureTo(context, 9, '失敗當下畫面').catch(() => {});
  } finally {
    const diagnosticsPath = path.join(PATHS.probeDir, 'diagnostics.json');
    await fs.writeFile(
      diagnosticsPath,
      JSON.stringify(
        { capturedAt: new Date().toISOString(), stepLog, failure, frames: await describeFrames(page) },
        null,
        2,
      ),
      'utf8',
    );
    log.info(`診斷資訊：${path.relative(process.cwd(), diagnosticsPath)}`);
  }
}

/**
 * 互動式探測：使用者手動點到目標畫面，回終端機按 Enter 即輸出該畫面結構。
 * 保留作為自動探測失敗時的備援。
 * @param {import('playwright-core').BrowserContext} context
 */
export async function runInteractiveProbe(context) {
  await fs.mkdir(PATHS.probeDir, { recursive: true });
  log.step('進入互動探測模式');
  log.info('在瀏覽器點到想分析的畫面 → 回終端機按 Enter 擷取；輸入 q 結束。');
  log.info('本模式只記錄欄位與選項名稱，不會記錄任何個案資料。');

  let sequence = 1;
  for (;;) {
    const answer = await prompt(`\n[${sequence}] 按 Enter 擷取目前畫面結構（q=結束）：`);
    // null 代表輸入串流結束（EOF），視同結束，否則會變成無限擷取。
    if (answer === null || answer.toLowerCase() === 'q') break;
    const pages = await collectAllPages(context);
    const label = pages.flatMap((item) => item.frames).find((frame) => frame.title)?.title ?? 'page';
    await captureTo(context, sequence, label);
    sequence += 1;
  }
  log.ok('互動探測結束');
}
