/**
 * PDF 編輯的輸出：
 * - 有塗黑或馬賽克的頁面 → 整頁轉成圖片再放回去。**底下的文字、隱藏圖層、註解一併消失**，
 *   這才是真正的遮蔽（只蓋一個黑框的話，文字其實還在，複製貼上就看得到）。
 * - 只有螢光筆的頁面 → 保留原本的向量內容（文字仍可選取、搜尋），在上面疊半透明色塊。
 * - 沒有標記的頁面 → 原樣複製。
 */
import { BlendMode, PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { PDF_EDIT_CONFIG } from '../config/pdfTools';
import { cappedScale, hexToRgb01, marksForPage, pageNeedsFlatten } from './pdfEditLogic';
import { loadPdfDocument } from './pdfEngine';
import { paintMarks } from './pdfMarkPaint';
import { getPageGeometry, renderPageToCanvas, type PDFDocumentProxy } from './pdfRender';
import type { EditMark } from '../types/pdfTools';

function canvasToJpegBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('頁面轉成圖片失敗（可能是頁面太大、記憶體不足）'));
          return;
        }
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      'image/jpeg',
      PDF_EDIT_CONFIG.jpegQuality,
    );
  });
}

/** 把整頁（含標記）畫成圖片，放進輸出檔成為新的一頁。 */
async function addFlattenedPage(
  output: PDFDocument,
  preview: PDFDocumentProxy,
  pageIndex: number,
  marks: readonly EditMark[],
): Promise<void> {
  const geometry = await getPageGeometry(preview, pageIndex + 1);
  const scale = cappedScale(geometry.width, geometry.height, PDF_EDIT_CONFIG.exportScale, PDF_EDIT_CONFIG.maxExportSide);
  const canvas = await renderPageToCanvas(preview, pageIndex + 1, scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器無法建立繪圖區（pdfEditExport addFlattenedPage）');
  paintMarks(ctx, marks, pageIndex);
  const image = await output.embedJpg(await canvasToJpegBytes(canvas));
  output
    .addPage([geometry.width, geometry.height])
    .drawImage(image, { x: 0, y: 0, width: geometry.width, height: geometry.height });
}

/**
 * 在原頁面上疊螢光筆色塊。先把原內容整包 q…Q 隔開，再開一段新的內容串流來畫，
 * 避免原檔內容沒有還原座標狀態時，色塊被畫到錯的位置。
 */
async function drawHighlights(
  page: PDFPage,
  preview: PDFDocumentProxy,
  pageIndex: number,
  pageMarks: readonly EditMark[],
): Promise<void> {
  const geometry = await getPageGeometry(preview, pageIndex + 1);
  page.translateContent(0, 0);
  // pdf-lib 沒公開「另開新串流」，這是它內部同名方法（參數 false＝不沿用前一段）。
  (page as unknown as { getContentStream(useExisting: boolean): unknown }).getContentStream(false);
  for (const mark of pageMarks) {
    const [x1, y1] = geometry.toPdfPoint(mark.x * geometry.width, mark.y * geometry.height);
    const [x2, y2] = geometry.toPdfPoint((mark.x + mark.width) * geometry.width, (mark.y + mark.height) * geometry.height);
    const { r, g, b } = hexToRgb01(mark.color ?? PDF_EDIT_CONFIG.highlightColors[0].value);
    page.drawRectangle({
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      color: rgb(r, g, b),
      blendMode: BlendMode.Multiply,
    });
  }
}

/** 依標記輸出編輯後的新 PDF。onProgress 回報處理到第幾頁（1 起算）。 */
export async function exportEditedPdf(
  bytes: Uint8Array,
  fileName: string,
  preview: PDFDocumentProxy,
  marks: readonly EditMark[],
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const original = await loadPdfDocument(bytes, fileName);
  const output = await PDFDocument.create();
  const total = original.getPageCount();
  for (let pageIndex = 0; pageIndex < total; pageIndex++) {
    const pageMarks = marksForPage(marks, pageIndex);
    if (pageNeedsFlatten(pageMarks)) {
      await addFlattenedPage(output, preview, pageIndex, marks);
    } else {
      const [copied] = await output.copyPages(original, [pageIndex]);
      output.addPage(copied);
      if (pageMarks.length) await drawHighlights(copied, preview, pageIndex, pageMarks);
    }
    onProgress?.(pageIndex + 1, total);
  }
  return output.save();
}
