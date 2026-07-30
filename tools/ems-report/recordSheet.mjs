/**
 * 開啟「救護紀錄表」並取得其文字內容。
 *
 * 這一步是整個解鎖流程唯一會碰到個案明細的地方，設計上刻意做成：
 *   點開 → 取文字 → 只留兩個欄位 → 立刻關閉視窗、丟棄全文。
 *
 * ⚠ 個資原則：**紀錄表本身絕不落檔**（不下載、不截圖、不寫暫存），
 *   全文只存在記憶體中，函式回傳後即無參照。
 *
 * 系統可能用三種方式呈現紀錄表，三種都要能處理：
 *   1. 另開視窗顯示 PDF（Chrome 內建閱讀器）
 *   2. 直接觸發 PDF 檔下載
 *   3. 另開視窗顯示一般網頁
 */
import { UNLOCK } from './config.mjs';
import { log } from './logger.mjs';
import { clickMatch } from './pageFinder.mjs';
import { extractPdfText } from './pdfText.mjs';

/** 回應是不是 PDF。 */
function isPdfResponse(response) {
  const contentType = (response.headers()['content-type'] || '').toLowerCase();
  if (contentType.includes('application/pdf')) return true;
  const disposition = (response.headers()['content-disposition'] || '').toLowerCase();
  return disposition.includes('.pdf');
}

/** 把下載的串流讀成位元組（不落檔）。 */
async function readDownloadBytes(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * 點開紀錄表並取得文字。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Frame} frame 放著「救護紀錄PDF」按鈕的 frame
 * @param {string[]} buttonTexts 按鈕文字候選
 * @param {number} index 第幾個符合的按鈕（0 起算）
 * @param {{exact?: boolean}} [options] 文字比對方式，**必須與當初算出 index 時完全相同**，
 *   否則兩邊的符合集合不一樣，序號會對到別張紀錄表
 * @returns {Promise<{text: string, kind: 'pdf'|'html', source: string}>}
 */
export async function openRecordSheet(context, frame, buttonTexts, index = 0, options = {}) {
  /** @type {Buffer|null} */
  let pdfBytes = null;
  /** @type {string} */
  let pdfSource = '';
  /** @type {import('playwright-core').Page[]} */
  const openedPages = [];

  const onResponse = async (response) => {
    if (pdfBytes || !isPdfResponse(response)) return;
    try {
      pdfBytes = await response.body();
      pdfSource = '另開視窗的 PDF 回應';
    } catch {
      // 回應主體可能已被瀏覽器接手（例如轉為下載），交給下載那條路處理。
    }
  };
  const onDownload = async (download) => {
    if (pdfBytes) return;
    try {
      pdfBytes = await readDownloadBytes(download);
      pdfSource = 'PDF 檔下載';
    } catch (error) {
      log.warn(`讀取下載的紀錄表失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const attach = (target) => {
    target.on('response', onResponse);
    target.on('download', onDownload);
  };
  const onNewPage = (newPage) => {
    openedPages.push(newPage);
    attach(newPage);
  };

  for (const openPage of context.pages()) attach(openPage);
  context.on('page', onNewPage);

  try {
    const clicked = await clickMatch(frame, buttonTexts, index, { exact: options.exact ?? false });
    if (!clicked) {
      throw new Error(`找不到第 ${index + 1} 個「${buttonTexts[0]}」按鈕，畫面可能已改版`);
    }

    const deadline = Date.now() + UNLOCK.sheetTimeoutMs;
    let htmlPage = null;
    // 取回 PDF 只試一次：失敗多半是網址本身不能重取（POST 產生的），
    // 每半秒重打一次只是徒增對方系統的負擔。
    const fetchedUrls = new Set();
    while (Date.now() < deadline) {
      if (pdfBytes) break;
      // 新視窗若是一般網頁，等它載完再判斷；是 PDF 的話上面的監聽會先命中。
      htmlPage = openedPages.find((item) => !item.isClosed() && item.url() !== 'about:blank') ?? null;
      if (htmlPage) {
        await htmlPage.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        const isPdfViewer = await htmlPage
          .evaluate(() => Boolean(document.querySelector('embed[type="application/pdf"], embed[name="plugin"]')))
          .catch(() => false);
        if (!isPdfViewer) break;

        // Chrome 用內建閱讀器顯示，DOM 裡讀不到內容，改用同一個工作階段直接取回檔案。
        const url = htmlPage.url();
        if (!fetchedUrls.has(url)) {
          fetchedUrls.add(url);
          const fetched = await context.request.get(url).catch(() => null);
          if (fetched && fetched.ok()) {
            pdfBytes = await fetched.body();
            pdfSource = '以同一登入狀態取回 PDF';
            break;
          }
          log.warn('紀錄表是 PDF 但取不回內容，改等下載或回應事件');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (pdfBytes) {
      const text = await extractPdfText(pdfBytes);
      if (!text.trim()) {
        throw new Error('紀錄表 PDF 讀得到檔案但抽不出文字（可能是掃描影像檔）');
      }
      return { text, kind: 'pdf', source: pdfSource };
    }

    if (htmlPage) {
      const text = await htmlPage.evaluate(() => document.body?.innerText ?? '');
      if (!text.trim()) throw new Error('紀錄表視窗開起來了，但頁面沒有任何文字');
      return { text, kind: 'html', source: '另開視窗的網頁' };
    }

    throw new Error(
      `按下「${buttonTexts[0]}」後 ${UNLOCK.sheetTimeoutMs / 1000} 秒內沒有出現紀錄表`
        + '（沒有新視窗、也沒有下載）',
    );
  } finally {
    context.off('page', onNewPage);
    for (const target of [...context.pages(), ...openedPages]) {
      target.off('response', onResponse);
      target.off('download', onDownload);
    }
    // 紀錄表視窗用完立刻關閉，畫面上不留個案明細。
    for (const openedPage of openedPages) {
      await openedPage.close().catch(() => {});
    }
    pdfBytes = null;
  }
}
