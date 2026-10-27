/**
 * PDF 工作區的輸出：依頁面清單（順序、旋轉、標記）產生新的 PDF。下載全部、只下載勾選、拆分、
 * 各檔分開下載都走這一支，輸出規則一致：
 * - 有塗黑或馬賽克的頁面 → 整頁轉成圖片再放回去。**底下的文字、隱藏圖層、註解一併消失**，
 *   這才是真正的遮蔽（只蓋一個黑框的話，文字其實還在，複製貼上就看得到）。
 * - 只有螢光筆的頁面 → 保留原本的向量內容（文字仍可選取、搜尋），在上面疊半透明色塊。
 * - 沒有標記的頁面 → 原樣複製（只套用旋轉）。
 */
import { BlendMode, PDFDocument, degrees, rgb, type PDFPage } from 'pdf-lib';
import { PDF_EDIT_CONFIG } from '../config/pdfTools';
import { cappedScale, hexToRgb01, markToDisplay, normalizeRotation, pageNeedsFlatten, rotatedSize } from './pdfEditLogic';
import { loadPdfDocument } from './pdfEngine';
import { paintMarks } from './pdfMarkPaint';
import { getPageGeometry, renderPageToCanvas } from './pdfRender';
import type { OutputPdfFile, WorkPage, WorkSource } from '../types/pdfTools';

type ProgressHandler = (done: number, total: number) => void;

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

function requireSource(sources: ReadonlyMap<string, WorkSource>, sourceId: string): WorkSource {
  const source = sources.get(sourceId);
  if (!source) throw new Error('找不到這一頁的來源檔（pdfWorkspaceExport）');
  return source;
}

/** 把整頁（含標記、含旋轉）畫成圖片，放進輸出檔成為新的一頁。 */
async function addFlattenedPage(output: PDFDocument, source: WorkSource, page: WorkPage): Promise<void> {
  const size = rotatedSize(source.pageSizes[page.sourcePageIndex], page.rotation);
  const scale = cappedScale(size.width, size.height, PDF_EDIT_CONFIG.exportScale, PDF_EDIT_CONFIG.maxExportSide);
  const absoluteRotation = normalizeRotation(source.baseRotations[page.sourcePageIndex] + page.rotation);
  const canvas = await renderPageToCanvas(source.preview, page.sourcePageIndex + 1, scale, absoluteRotation);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器無法建立繪圖區（pdfWorkspaceExport addFlattenedPage）');
  paintMarks(ctx, page.marks.map((mark) => markToDisplay(mark, page.rotation)));
  const image = await output.embedJpg(await canvasToJpegBytes(canvas));
  output.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
}

/**
 * 在原頁面上疊螢光筆色塊（標記為原方向座標，畫在 PDF 座標系裡，之後設定的旋轉會一起轉）。
 * 先把原內容整包 q…Q 隔開，再開一段新的內容串流來畫，避免原檔沒還原座標狀態時畫歪。
 */
async function drawHighlights(target: PDFPage, source: WorkSource, page: WorkPage): Promise<void> {
  const geometry = await getPageGeometry(source.preview, page.sourcePageIndex + 1);
  target.translateContent(0, 0);
  // pdf-lib 沒公開「另開新串流」，這是它內部同名方法（參數 false＝不沿用前一段）。
  (target as unknown as { getContentStream(useExisting: boolean): unknown }).getContentStream(false);
  for (const mark of page.marks) {
    const [x1, y1] = geometry.toPdfPoint(mark.x * geometry.width, mark.y * geometry.height);
    const [x2, y2] = geometry.toPdfPoint((mark.x + mark.width) * geometry.width, (mark.y + mark.height) * geometry.height);
    const { r, g, b } = hexToRgb01(mark.color ?? PDF_EDIT_CONFIG.highlightColors[0].value);
    target.drawRectangle({
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      color: rgb(r, g, b),
      blendMode: BlendMode.Multiply,
    });
  }
}

/** 同一個來源檔要原樣複製的頁一次複製完（分開複製會讓字型等共用資源重複，檔案變大）。 */
async function copyVectorPages(
  output: PDFDocument,
  pages: readonly WorkPage[],
  sources: ReadonlyMap<string, WorkSource>,
): Promise<Map<string, PDFPage>> {
  const copied = new Map<string, PDFPage>();
  const bySource = new Map<string, WorkPage[]>();
  pages
    .filter((page) => !pageNeedsFlatten(page.marks))
    .forEach((page) => bySource.set(page.sourceId, [...(bySource.get(page.sourceId) ?? []), page]));
  for (const [sourceId, sourcePages] of bySource) {
    const source = requireSource(sources, sourceId);
    const document = await loadPdfDocument(source.bytes, source.name);
    const result = await output.copyPages(document, sourcePages.map((page) => page.sourcePageIndex));
    sourcePages.forEach((page, index) => copied.set(page.id, result[index]));
  }
  return copied;
}

/** 依頁面清單產生一份 PDF。 */
async function buildPdf(
  pages: readonly WorkPage[],
  sources: ReadonlyMap<string, WorkSource>,
  onPageDone: () => void,
): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const copied = await copyVectorPages(output, pages, sources);
  for (const page of pages) {
    const source = requireSource(sources, page.sourceId);
    const vectorPage = copied.get(page.id);
    if (!vectorPage) {
      await addFlattenedPage(output, source, page);
    } else {
      output.addPage(vectorPage);
      if (page.marks.length > 0) await drawHighlights(vectorPage, source, page);
      vectorPage.setRotation(degrees(normalizeRotation(vectorPage.getRotation().angle + page.rotation)));
    }
    onPageDone();
  }
  return output.save();
}

/** 產生多個輸出檔（每組一個檔），進度以總頁數計。 */
export async function buildOutputFiles(
  groups: readonly { name: string; pages: readonly WorkPage[] }[],
  sources: ReadonlyMap<string, WorkSource>,
  onProgress?: ProgressHandler,
): Promise<OutputPdfFile[]> {
  const total = groups.reduce((sum, group) => sum + group.pages.length, 0);
  let done = 0;
  const files: OutputPdfFile[] = [];
  for (const group of groups) {
    const bytes = await buildPdf(group.pages, sources, () => onProgress?.(++done, total));
    files.push({ name: group.name, bytes });
  }
  return files;
}
