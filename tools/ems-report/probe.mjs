/**
 * 頁面結構探測 —— 用來讓開發者知道「這一頁有哪些欄位、按鈕、選項」，
 * 以便寫出正確的自動化選擇器。
 *
 * ⚠ 個資原則（本檔最重要的規則）：
 *   只輸出「結構」不輸出「資料」。
 *   - 文字輸入框：只記錄 id / name / type，**不記錄使用者輸入的值**
 *   - 表格：只記錄欄位標題（th），**絕不記錄任何資料列（tbody 內容）**
 *   - 不截圖（截圖可能拍到個案明細）
 *   下拉選單的選項（如分隊名稱、救護狀態）屬於系統代碼表，非個資，故予保留。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { log, prompt } from './logger.mjs';

/** 在瀏覽器端執行的擷取邏輯：只取結構。 */
function extractStructure() {
  const trim = (text) => (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  /** 只有按鈕類的 value 才是標籤文字，其餘輸入值一律不取（可能是個資）。 */
  const BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'image']);

  const links = [...document.querySelectorAll('a')]
    .map((element) => ({
      text: trim(element.textContent),
      onclick: trim(element.getAttribute('onclick')),
      href: trim(element.getAttribute('href')),
    }))
    .filter((item) => item.text || item.onclick);

  const inputs = [...document.querySelectorAll('input, textarea')].map((element) => {
    const type = (element.getAttribute('type') || element.tagName.toLowerCase()).toLowerCase();
    return {
      type,
      id: element.id || '',
      name: element.getAttribute('name') || '',
      className: trim(element.className),
      label: BUTTON_TYPES.has(type) ? trim(element.getAttribute('value')) : '',
      onclick: trim(element.getAttribute('onclick')),
    };
  });

  const selects = [...document.querySelectorAll('select')].map((element) => ({
    id: element.id || '',
    name: element.getAttribute('name') || '',
    options: [...element.options].map((option) => ({
      value: option.value,
      text: trim(option.textContent),
    })),
  }));

  const buttons = [...document.querySelectorAll('button')].map((element) => ({
    id: element.id || '',
    name: element.getAttribute('name') || '',
    text: trim(element.textContent),
    onclick: trim(element.getAttribute('onclick')),
  }));

  // 表格只取標題列，資料列一律不取。
  const tables = [...document.querySelectorAll('table')]
    .map((table, index) => ({
      index,
      id: table.id || '',
      headers: [...table.querySelectorAll('th')].map((cell) => trim(cell.textContent)).filter(Boolean),
      rowCount: table.rows.length,
    }))
    .filter((table) => table.headers.length > 0);

  return { title: document.title, links, inputs, selects, buttons, tables };
}

/** 擷取單一分頁（含其所有 frame）的結構。 */
async function collectFrames(page) {
  const results = [];
  for (const frame of page.frames()) {
    try {
      const structure = await frame.evaluate(extractStructure);
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
 * 系統的進階搜尋是彈出式視窗，會成為獨立的 page，只掃主視窗會漏掉。
 */
async function collectAllPages(context) {
  const pages = [];
  for (const [index, page] of context.pages().entries()) {
    if (page.isClosed()) continue;
    pages.push({
      pageIndex: index,
      pageUrl: page.url(),
      frames: await collectFrames(page),
    });
  }
  return pages;
}

/** 產生檔名安全的標籤。 */
function toSafeLabel(label, sequence) {
  const cleaned = label.replace(/[^\w一-龥-]/g, '_').slice(0, 40);
  return `${String(sequence).padStart(2, '0')}-${cleaned || 'page'}`;
}

/**
 * 互動式探測：使用者在瀏覽器手動點到目標畫面，回終端機按 Enter 即輸出該畫面結構。
 * @param {import('playwright-core').BrowserContext} context
 */
export async function runInteractiveProbe(context) {
  await fs.mkdir(PATHS.probeDir, { recursive: true });
  log.step('進入探測模式');
  log.info('操作方式：在瀏覽器點到想分析的畫面 → 回到這個終端機按 Enter → 會存下該畫面的「結構」。');
  log.info('彈出式視窗也會一併記錄，不需要關掉它。');
  log.info('輸入 q 後按 Enter 可結束。');
  log.info('本模式只記錄欄位與選項名稱，不會記錄任何個案資料。');

  let sequence = 1;
  for (;;) {
    const answer = await prompt(`\n[${sequence}] 按 Enter 擷取目前畫面結構（q=結束）：`);
    if (answer.toLowerCase() === 'q') break;

    const pages = await collectAllPages(context);
    const label = pages.flatMap((page) => page.frames).find((frame) => frame.title)?.title ?? 'page';
    const fileName = `${toSafeLabel(label, sequence)}.json`;
    const filePath = path.join(PATHS.probeDir, fileName);
    await fs.writeFile(filePath, JSON.stringify({ capturedAt: new Date().toISOString(), pages }, null, 2), 'utf8');

    const frameCount = pages.reduce((sum, page) => sum + page.frames.length, 0);
    log.ok(`已存出：${path.relative(process.cwd(), filePath)}（${pages.length} 個視窗 / ${frameCount} 個 frame）`);
    sequence += 1;
  }
  log.ok('探測模式結束');
}
