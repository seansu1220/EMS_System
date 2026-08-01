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
 * 讀取一個視窗裡的文字。
 *
 * **必須走訪所有 frame**：這套系統的頁面常是 frameset，
 * 而 frameset 文件沒有 `<body>`，只讀主文件會永遠得到空字串（實跑踩過這個坑）。
 */
async function readAllFramesText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 這個視窗是不是 PDF。
 * 以 `document.contentType` 為主：Chrome 用內建閱讀器顯示 PDF 時，
 * 文件的 contentType 就是 `application/pdf`，比找 embed 標籤可靠。
 */
async function isPdfPage(page) {
  return page
    .evaluate(
      () =>
        document.contentType === 'application/pdf'
        || Boolean(
          document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]'),
        ),
    )
    .catch(() => false);
}

/**
 * 失敗時的診斷：說明每個新視窗的**結構**，不輸出任何內容。
 * 網址只留路徑最後一段並遮蔽數字，因為查詢字串可能帶案件編號。
 */
async function describeOpenedPages(pages) {
  const descriptions = [];
  for (const page of pages) {
    if (page.isClosed()) {
      descriptions.push('（視窗已被關閉）');
      continue;
    }
    const info = await page
      .evaluate(() => ({
        contentType: document.contentType,
        hasBody: Boolean(document.body),
        frameCount: document.querySelectorAll('frame, iframe').length,
        textLength: (document.body?.innerText ?? '').trim().length,
        readyState: document.readyState,
      }))
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    const path = page.url().split('?')[0].split('/').pop()?.replace(/\d{5,}/g, '#####') ?? '';
    descriptions.push(`${path || '(無網址)'}：${JSON.stringify(info)}`);
  }
  return descriptions.join('；');
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
  /** 系統用 alert／confirm 擋下時的訊息（已遮蔽長數字），沒被擋則為 null。 */
  let blockedMessage = null;
  const onDialog = async (dialog) => {
    blockedMessage = dialog.message().replace(/\d{5,}/g, '#####').slice(0, 80);
    log.warn(`系統跳出訊息：「${blockedMessage}」`);
    // 維持 Playwright 的預設動作（關閉／取消）：這裡只是唯讀地開紀錄表，
    // 按下確定有可能觸發我們沒預期的動作，寧可如實記下訊息交給人判斷。
    await dialog.dismiss().catch(() => {});
  };
  const attach = (target) => {
    target.on('response', onResponse);
    target.on('download', onDownload);
    // 不接手的話 Playwright 會自動關掉對話框且不留任何痕跡，
    // 程式只會傻等到逾時，事後完全看不出系統其實有回話。
    target.on('dialog', onDialog);
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

    // 一路等到「真的拿到內容」為止，不能一看到視窗就判定成敗：
    // 視窗常是先開好、內容才由後續的 POST 填進來（實跑時因此只等了 4 秒就誤判失敗）。
    const deadline = Date.now() + UNLOCK.sheetTimeoutMs;
    // 取回 PDF 每個網址只試一次：失敗多半是該網址本身不能重取（POST 產生的），
    // 每半秒重打一次只是徒增對方系統的負擔。
    const fetchedUrls = new Set();
    while (Date.now() < deadline && !pdfBytes) {
      for (const candidate of openedPages) {
        if (candidate.isClosed()) continue;
        await candidate.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

        if (await isPdfPage(candidate)) {
          // Chrome 用內建閱讀器顯示，DOM 裡讀不到內容，改用同一個登入狀態取回檔案。
          const url = candidate.url();
          if (!fetchedUrls.has(url)) {
            fetchedUrls.add(url);
            const fetched = await context.request.get(url).catch(() => null);
            if (fetched && fetched.ok()) {
              pdfBytes = await fetched.body();
              pdfSource = '以同一登入狀態取回 PDF';
              break;
            }
            log.warn('紀錄表是 PDF 但取不回內容，繼續等下載或回應事件');
          }
          continue;
        }

        const text = await readAllFramesText(candidate);
        if (text.trim()) return { text, kind: 'html', source: '另開視窗的網頁' };
      }
      if (pdfBytes) break;
      // 系統已經明說開不了，再等下去也不會有紀錄表，早點結束才不會白等一分鐘。
      if (blockedMessage) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (pdfBytes) {
      const text = await extractPdfText(pdfBytes);
      if (!text.trim()) {
        throw new Error('紀錄表 PDF 讀得到檔案但抽不出文字（可能是掃描影像檔）');
      }
      return { text, kind: 'pdf', source: pdfSource };
    }

    const waited = UNLOCK.sheetTimeoutMs / 1000;
    if (blockedMessage) {
      throw new Error(
        `按下「${buttonTexts[0]}」後系統跳出訊息：「${blockedMessage}」，紀錄表沒有開啟`,
      );
    }
    if (openedPages.length === 0) {
      throw new Error(
        `按下「${buttonTexts[0]}」後 ${waited} 秒內沒有出現紀錄表（沒有新視窗、也沒有下載）`,
      );
    }
    throw new Error(
      `紀錄表視窗開起來了，但 ${waited} 秒內都讀不到內容。`
        + `視窗狀態：${await describeOpenedPages(openedPages)}`,
    );
  } finally {
    context.off('page', onNewPage);
    for (const target of [...context.pages(), ...openedPages]) {
      target.off('response', onResponse);
      target.off('download', onDownload);
      target.off('dialog', onDialog);
    }
    // 紀錄表視窗用完立刻關閉，畫面上不留個案明細。
    for (const openedPage of openedPages) {
      await openedPage.close().catch(() => {});
    }
    pdfBytes = null;
  }
}
