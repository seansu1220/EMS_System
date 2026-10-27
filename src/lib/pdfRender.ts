/**
 * PDF 頁面縮圖繪製（使用 pdf.js）。
 * 用 legacy 版本以相容較舊的瀏覽器（公務機、舊手機）；worker 由 Vite 打包成獨立檔。
 */
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

/** 開啟 PDF 供繪製縮圖（pdf.js 會把傳入的資料轉交給 worker，所以傳入複本）。 */
export async function openPdfForPreview(bytes: Uint8Array, fileName: string): Promise<PDFDocumentProxy> {
  try {
    return await getDocument({ data: bytes.slice() }).promise;
  } catch (error) {
    throw new Error(`「${fileName}」無法預覽：${(error as Error).message}`);
  }
}

/** 關閉預覽文件、釋放 worker 與記憶體（pdf.js v6 起改由 loadingTask 負責）。 */
export function closePdfPreview(pdf: PDFDocumentProxy): void {
  pdf.loadingTask.destroy().catch((error) => console.error('關閉 PDF 預覽失敗（pdfRender closePdfPreview）：', error));
}

/** 將某一頁畫到 canvas：CSS 寬度固定、高度依比例，回傳 CSS 尺寸供旋轉時計算縮放。 */
export async function renderPageThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): Promise<{ width: number; height: number }> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const pixelRatio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * pixelRatio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const cssHeight = (cssWidth * base.height) / base.width;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  await page.render({ canvas, viewport }).promise;
  return { width: cssWidth, height: cssHeight };
}
