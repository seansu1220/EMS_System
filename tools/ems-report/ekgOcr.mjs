/**
 * 照片裡的字**讀出來**（OCR），用來判斷這張照片是不是 12 導程心電圖。
 *
 * 同仁多半是把心電圖印出來拍照上傳，所以「案件影音」裡絕大多數是 jpg
 * （使用者 2026-09-21 指出）。全部丟給人看，等於這個功能只做了一半。
 *
 * ## 整條路怎麼走
 *
 *   1. 把照片丟進**已經開著的那個瀏覽器**，用 canvas 轉成純黑白（見下方「為什麼要二值化」）
 *   2. 把黑白圖交給 Tesseract 辨識
 *   3. 認不出足夠的字樣就換一個門檻再試一輪，試完還是不行就回報「讀不出來」
 *
 * ## 為什麼要二值化（2026-09-21 實測）
 *
 * 心電圖紙有格線。直接 OCR 的結果是整頁 `EB 0 0 6 0 1 0 5` 這種雜訊
 * ——格線被當成一個一個字讀進去了，導程名稱一個都認不出來。
 * 先轉成純黑白（只留最暗的那一小部分像素）之後，同一張圖 OCR 出來是：
 *
 * ```
 * 12-Lead ECG 2026-07-06 12:40
 * I avR v1 v4 / II avL v2 v5 / III avF v3 v6
 * ```
 *
 * 門檻用**百分位**而不是固定亮度：固定門檻碰到曝光不足或過曝的照片就整張全黑或全白，
 * 而「最暗的 N% 像素當成墨水」會自動跟著照片的亮度走。
 *
 * ⚠ 百分位只在**「不是紙」的像素**上算（亮度 ≤ `paperLuminanceFrom`）。
 *   這一條是成敗關鍵：在整張圖上算的話，同一張心電圖「拍得緊」與
 *   「四周留很多白」會得到完全不同的門檻，後者一個導程名稱都認不出來。
 *   改成只看非紙像素之後，三種版面都第一輪就認出七個導程名稱（各約 0.2 秒）。
 *
 * ## 為什麼借用瀏覽器做影像處理
 *
 * 這支流程本來就開著一個 Chromium（登入救護系統用的），而縮圖與二值化正是 canvas
 * 最擅長的事。改用純 JS 的影像套件要多裝 JPEG／PNG 兩個解碼器、自己寫縮放，
 * 還得處理各種相機的色彩空間——瀏覽器這些全都做好了。
 *
 * ⚠ 個資原則：照片**只在記憶體與瀏覽器分頁裡存在**，辨識完立刻關掉分頁，
 *   不落檔、不截圖。回傳的只有辨識出來的文字，而那段文字也只用來比對字樣，
 *   不會寫進任何輸出檔（人工判定清單上只寫「程式讀到什麼字樣」的結論）。
 */
import path from 'node:path';
import { EKG, PATHS } from './config.mjs';
import { log } from './logger.mjs';

/** Tesseract 的 worker 很貴（建一次約 1 秒），整趟查核共用一個。 */
let workerPromise = null;

/** 只提醒一次「沒裝套件」，跑幾百件不必每件都講。 */
let warnedMissingPackage = false;

/**
 * 取得（必要時建立）共用的 Tesseract worker。
 *
 * 套件沒裝時**不讓整個流程掛掉**：OCR 是加分功能，讀不出來的照片本來就會
 * 列給使用者自己看，退回那條路即可（與 `pdfText.mjs` 對 pdfjs 的處理一致）。
 *
 * @returns {Promise<any|null>} 建不起來時回傳 null
 */
async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    let tesseract;
    try {
      tesseract = await import('tesseract.js');
    } catch {
      if (!warnedMissingPackage) {
        warnedMissingPackage = true;
        log.warn(
          '照片要靠 tesseract.js 才讀得出字，這台電腦沒有這個套件。'
            + '請在專案資料夾執行一次 npm install；在那之前，照片一律列給你自己點開看。',
        );
      }
      return null;
    }
    const { ocr } = EKG.verify.media;
    log.info(`準備照片辨識（第一次執行會下載約 4 MB 的語言資料到 ${ocr.cacheDir}）`);
    return tesseract.createWorker(ocr.language, 1, {
      cachePath: path.join(PATHS.toolDir, ocr.cacheDir),
      // Tesseract 自己的進度訊息很吵（每張圖幾十行），這支流程已經有自己的紀錄。
      logger: () => {},
    });
  })().catch((error) => {
    log.warn(`照片辨識準備失敗（照片會改列給你自己看）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  return workerPromise;
}

/**
 * 收掉 worker。**整趟查核跑完一定要呼叫**，否則 Tesseract 的背景執行緒
 * 會讓 Node 程序遲遲不結束（與 `pdfText.mjs` 要 destroy loadingTask 同一個道理）。
 */
export async function closeOcr() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  await worker?.terminate?.().catch(() => {});
}

/**
 * 在瀏覽器裡把圖片縮小並轉成純黑白，回傳 PNG 的 base64。
 *
 * 這段程式碼會被序列化送進瀏覽器執行，**不能引用模組作用域的任何東西**，
 * 因此設定值一律由參數帶進去。
 *
 * ⚠ 參數包成一個物件：`page.evaluate()` 只餵一個參數給頁面端的函式。
 *
 * @param {{dataUrl: string, percentileOfInk: number, dropColor: boolean, maxEdge: number,
 *   paperFrom: number, saturationFrom: number}} params
 * @returns {Promise<string|null>} `data:image/png;base64,…`；圖片讀不進來時回傳 null
 */
function thresholdInPage(params) {
  return (async () => {
    const { dataUrl, percentileOfInk, dropColor, maxEdge, paperFrom, saturationFrom } = params;
    const image = new Image();
    image.src = dataUrl;
    try {
      await image.decode();
    } catch {
      return null; // 壞檔、或瀏覽器不認得這種格式（例如 heic）
    }

    // 縮圖：手機照片動輒 4000×3000，OCR 一張要十幾秒。
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);

    const pixels = context.getImageData(0, 0, width, height);
    const data = pixels.data;
    // 先算亮度直方圖，才知道「最暗的 N%」是哪個亮度。
    const histogram = new Uint32Array(256);
    const luminance = new Uint8Array(data.length / 4);
    for (let offset = 0, index = 0; offset < data.length; offset += 4, index += 1) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      // 有顏色的（心電圖紙的粉紅格線）直接當成紙，不讓它參與門檻計算。
      const colored = Math.max(red, green, blue) - Math.min(red, green, blue) >= saturationFrom;
      const value = (dropColor && colored) ? 255 : (0.299 * red + 0.587 * green + 0.114 * blue) | 0;
      luminance[index] = value;
      histogram[value] += 1;
    }

    // ⚠ 百分位只在「不是紙」的像素上算。在整張圖上算的話，
    //   同一張心電圖拍得緊或四周留很多白會得到完全不同的門檻（2026-09-21 實測）。
    let inkCandidates = 0;
    for (let value = 0; value <= paperFrom; value += 1) inkCandidates += histogram[value];
    const wanted = Math.max(1, Math.floor((inkCandidates * percentileOfInk) / 100));
    let accumulated = 0;
    let cut = 0;
    for (let value = 0; value < 256; value += 1) {
      accumulated += histogram[value];
      if (accumulated >= wanted) {
        cut = value;
        break;
      }
    }

    for (let offset = 0, index = 0; offset < data.length; offset += 4, index += 1) {
      const value = luminance[index] <= cut ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255; // 透明底會被當成黑色，一律補成不透明
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png');
  })();
}

/**
 * 把一張照片轉成黑白 PNG。
 *
 * 每次都開一個新分頁再關掉：查核流程那個分頁停在案件內部，不可以拿來畫圖。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} dataUrl
 * @param {{dropColor: boolean, percentileOfInk: number}} pass 這一輪的參數
 * @returns {Promise<Buffer|null>}
 */
async function toMonochromePng(context, dataUrl, pass) {
  const { ocr } = EKG.verify.media;
  const page = await context.newPage();
  try {
    // 把函式本身交給 Playwright 序列化送進瀏覽器（所以它不能引用模組作用域）。
    const result = await page.evaluate(thresholdInPage, {
      dataUrl,
      percentileOfInk: pass.percentileOfInk,
      dropColor: pass.dropColor,
      maxEdge: ocr.maxEdgePixels,
      paperFrom: ocr.paperLuminanceFrom,
      saturationFrom: ocr.colorSaturationFrom,
    });
    return result ? Buffer.from(String(result).split(',')[1], 'base64') : null;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 讀出一張照片裡的文字。
 *
 * 依序試幾輪不同參數，把每一輪讀到的文字**疊在一起**回傳。
 *
 * 為什麼要疊（2026-09-21 實測）：不同參數讀得到的導程名稱不一樣，
 * 單輪最多只認出 3 個（不足 4 個而判不出來），但幾輪的聯集有 7 個。
 * 呼叫端用 `shouldStop` 在認出足夠字樣時提早收工，多數照片只會跑第一輪。
 *
 * @param {import('playwright-core').BrowserContext} context 已經開著的瀏覽器
 * @param {Buffer|Uint8Array} bytes 原圖位元組
 * @param {string} mimeType 例如 `image/jpeg`
 * @param {(textSoFar: string) => boolean} [shouldStop] 讀到足夠就停，省下後面幾輪
 * @returns {Promise<{text: string, rounds: number}>} 讀不出任何東西時 text 為空字串
 */
export async function readImageText(context, bytes, mimeType, shouldStop = () => false) {
  const { ocr } = EKG.verify.media;
  if (!ocr.enabled) return { text: '', rounds: 0 };
  const worker = await getWorker();
  if (!worker) return { text: '', rounds: 0 };

  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  const collected = [];
  let rounds = 0;

  for (const pass of ocr.passes) {
    rounds += 1;
    const label = `${pass.dropColor ? '去色' : '不去色'} ${pass.percentileOfInk}%`;
    const png = await toMonochromePng(context, dataUrl, pass).catch((error) => {
      log.info(`　照片轉黑白失敗（${label}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!png) continue;

    // 逾時要自己管：Tesseract 沒有 timeout 參數，而一張壞掉的圖可能跑很久。
    const recognized = await Promise.race([
      worker.recognize(png).then((result) => String(result?.data?.text ?? '')),
      new Promise((resolve) => { setTimeout(() => resolve(null), ocr.timeoutMs); }),
    ]).catch(() => null);

    if (recognized === null) {
      log.info(`　照片辨識逾時（${label}），跳過這一輪`);
      continue;
    }
    collected.push(recognized);
    if (shouldStop(collected.join('\n'))) break;
  }

  return { text: collected.join('\n'), rounds };
}
