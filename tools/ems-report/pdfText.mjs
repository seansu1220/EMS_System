/**
 * PDF → 純文字（只在記憶體處理，不落檔）。
 *
 * ⚠ 個資原則：救護紀錄表整張都是個案明細。本檔**只把位元組轉成文字回傳**，
 *   絕不寫入任何檔案；呼叫端只會從文字中挑出案號與 TEMSIS 兩個欄位，其餘立即丟棄。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** pdfjs 只在真的遇到 PDF 時才載入，沒裝也不影響其他功能。 */
let pdfjsPromise = null;

/**
 * 載入 pdfjs（legacy 版才適用於 Node）。
 * @returns {Promise<{pdfjs: any, cMapUrl: string, standardFontDataUrl: string}>}
 */
function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const require = createRequire(import.meta.url);
    let packagePath;
    try {
      packagePath = require.resolve('pdfjs-dist/package.json');
    } catch {
      throw new Error(
        '救護紀錄表是 PDF，需要 pdfjs-dist 套件才能讀取。請在專案資料夾執行一次 npm install 後再試。',
      );
    }
    const packageRoot = path.dirname(packagePath);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return {
      pdfjs,
      // 中文 PDF 常用 CID 字型，少了 cmaps 會抽出一堆亂碼；字型資料就在套件內，離線可用。
      cMapUrl: `${pathToFileURL(path.join(packageRoot, 'cmaps')).href}/`,
      standardFontDataUrl: `${pathToFileURL(path.join(packageRoot, 'standard_fonts')).href}/`,
    };
  })();
  return pdfjsPromise;
}

/**
 * 把 PDF 位元組轉成純文字。
 *
 * @param {Uint8Array|Buffer} bytes PDF 內容
 * @param {{maxPages?: number}} [options]
 * @returns {Promise<string>} 各頁文字（以換行分隔）
 */
export async function extractPdfText(bytes, options = {}) {
  const { pdfjs, cMapUrl, standardFontDataUrl } = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    // 這份 PDF 來自外部系統，關掉 eval 與外部資源存取，只做純文字解析。
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;

  try {
    const pageCount = Math.min(document.numPages, options.maxPages ?? 5);
    const pageTexts = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      // hasEOL 代表這段文字後面換行；保留換行有助於「標籤與值相鄰」的判讀。
      const text = content.items
        .map((item) => (typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      pageTexts.push(text);
      page.cleanup();
    }
    return pageTexts.join('\n');
  } finally {
    // 一定要收掉，否則 pdfjs 的背景工作會讓 Node 程序遲遲不結束。
    // 銷毀的入口在 loadingTask（新版的 document 物件沒有 destroy）。
    await loadingTask.destroy().catch(() => {});
  }
}

/**
 * @typedef {Object} PdfTextItem PDF 上的一段文字與它的位置
 * @property {number} page 第幾頁（1 起算）
 * @property {number} x 左下角 x（PDF 座標，單位 pt）
 * @property {number} y 左下角 y（PDF 座標，**由下往上**增加）
 * @property {number} width
 * @property {number} height
 * @property {string} str 文字
 * @property {boolean} hasEOL 這段後面換行
 * @property {number} dirX 文字前進方向（單位向量 x）：一般橫書為 1
 * @property {number} dirY 文字前進方向（單位向量 y）：整頁轉 90 度的表格為 1（救護紀錄表就是這樣）
 */

/**
 * 把 PDF 位元組轉成「文字＋位置」的清單（紀錄表取樣用，看版面結構）。
 *
 * ⚠ 個資：回傳的仍是原文，呼叫端負責遮蔽後才可寫檔（見 `sheetSample.mjs`）。
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{maxPages?: number}} [options]
 * @returns {Promise<PdfTextItem[]>}
 */
export async function extractPdfItems(bytes, options = {}) {
  const { pdfjs, cMapUrl, standardFontDataUrl } = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  try {
    const pageCount = Math.min(document.numPages, options.maxPages ?? 5);
    const items = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        items.push({
          page: pageNumber,
          x: Math.round(item.transform[4] * 10) / 10,
          y: Math.round(item.transform[5] * 10) / 10,
          width: Math.round((item.width ?? 0) * 10) / 10,
          height: Math.round((item.height ?? 0) * 10) / 10,
          str: item.str,
          hasEOL: Boolean(item.hasEOL),
          ...textDirection(item.transform),
        });
      }
      page.cleanup();
    }
    return items;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

/** 由文字矩陣取出前進方向（單位向量）；讀不出來當成一般橫書。 */
function textDirection(transform) {
  const [a, b] = transform;
  const length = Math.hypot(a, b);
  if (!length) return { dirX: 1, dirY: 0 };
  return { dirX: Math.round((a / length) * 1000) / 1000, dirY: Math.round((b / length) * 1000) / 1000 };
}
