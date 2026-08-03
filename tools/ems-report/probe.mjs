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
import { PATHS } from './config.mjs';
import { log, prompt } from './logger.mjs';
import { gotoRecordQuery, toggleAdvancedSearch } from './navigation.mjs';

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

  /**
   * 元素「旁邊看得到的文字」。
   *
   * 為什麼一定要記：這一頁有 400 多個勾選框，id 全是 `_scarcbc040102` 這種代碼，
   * 光看 id 完全無從得知哪一個是「EKG檢查」。沒有這一欄的話，
   * 每次要對應一個新欄位都得請使用者重新登入探測一次（2026-08-03 實際踩到）。
   *
   * ⚠ 個資：標籤文字屬**表單結構**（欄位叫什麼名字），不是使用者填的值；
   *   仍照 `clean` 遮蔽 5 碼以上數字並截斷。
   */
  const nearbyTextOf = (element) => {
    if (element.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (explicit) return clean(explicit.textContent, 30);
    }
    const wrapping = element.closest('label');
    if (wrapping) return clean(wrapping.textContent, 30);
    const cell = element.closest('td, th');
    if (!cell) return clean(element.nextElementSibling?.textContent, 30);
    // 同一格內就有文字（`<td><input>EKG檢查</td>`）優先；沒有才看左右相鄰的格子。
    return (
      clean(cell.textContent, 30)
      || clean(cell.nextElementSibling?.textContent, 30)
      || clean(cell.previousElementSibling?.textContent, 30)
    );
  };

  const inputs = [...document.querySelectorAll('input, textarea')].map((element) => {
    const type = (element.getAttribute('type') || element.tagName.toLowerCase()).toLowerCase();
    return {
      type,
      id: element.id || '',
      name: element.getAttribute('name') || '',
      className: clean(element.className, 60),
      label: BUTTON_TYPES.has(type) ? clean(element.getAttribute('value'), 40) : '',
      // 按鈕的文字已經在 label 裡；其餘欄位靠旁邊的文字才認得出來是什麼。
      nearbyText: BUTTON_TYPES.has(type) ? '' : nearbyTextOf(element),
      onclick: clean(element.getAttribute('onclick'), 160),
    };
  });

  const selects = [...document.querySelectorAll('select')].map((element) => ({
    id: element.id || '',
    name: element.getAttribute('name') || '',
    nearbyText: nearbyTextOf(element),
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

/** 供其他流程呼叫的快照序號（各流程共用同一個計數，檔名才不會互相覆蓋）。 */
let snapshotSequence = 0;

/**
 * 在流程進行中存下當下畫面的結構快照。
 *
 * 解鎖流程走的畫面尚未探測過，出問題時光看錯誤訊息不夠，
 * 有快照才知道那一頁實際有哪些欄位與按鈕。內容同樣只有結構、沒有資料。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} label 檔名用的標籤
 * @returns {Promise<string|null>} 存檔路徑；失敗時回傳 null（快照失敗不該中斷主流程）
 */
export async function captureSnapshot(context, label) {
  try {
    await fs.mkdir(PATHS.probeDir, { recursive: true });
    snapshotSequence += 1;
    return await captureTo(context, snapshotSequence, label);
  } catch (error) {
    log.warn(`存畫面結構快照失敗（不影響主流程）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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
    const expanded = await toggleAdvancedSearch(page);
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
