/**
 * PDF 工具的檔案處理：讀檔、合併、拆分、重排頁面、打包下載（使用 pdf-lib 與 JSZip）。
 * 全部在瀏覽器內完成，檔案不會上傳；錯誤一律轉成看得懂的中文訊息往上丟。
 */
import { PDFDocument, degrees } from 'pdf-lib';
import JSZip from 'jszip';
import { PDF_TOOLS_CONFIG } from '../config/pdfTools';
import { baseName, groupLabel, safeFilename } from './pdfPageLogic';
import type { ImagePageMode, MergeItem, OrganizedPage, OutputPdfFile, SplitMode } from '../types/pdfTools';

export async function readFileBytes(file: File): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw new Error(`讀取「${file.name}」失敗：${(error as Error).message}`);
  }
}

/** 以 pdf-lib 開啟 PDF；有密碼或檔案損毀時丟出看得懂的錯誤。 */
export async function loadPdfDocument(bytes: Uint8Array, fileName: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    if (/encrypt/i.test((error as Error).message)) {
      throw new Error(`「${fileName}」有密碼保護，請先解除密碼再處理`);
    }
    throw new Error(`「${fileName}」不是有效的 PDF 或檔案已損毀`);
  }
}

/** 圖片放進新頁面：A4 置中縮放（不放大），或依圖片原尺寸。 */
async function addImagePage(output: PDFDocument, item: MergeItem, mode: ImagePageMode): Promise<void> {
  let image;
  try {
    image = item.kind === 'png' ? await output.embedPng(item.bytes) : await output.embedJpg(item.bytes);
  } catch {
    throw new Error(`「${item.file.name}」圖片無法讀取，可能不是真正的 JPG／PNG`);
  }
  if (mode === 'original') {
    output.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return;
  }
  const [shortSide, longSide] = PDF_TOOLS_CONFIG.a4Size;
  const [pageWidth, pageHeight] = image.width > image.height ? [longSide, shortSide] : [shortSide, longSide];
  const margin = PDF_TOOLS_CONFIG.imageMargin;
  const scale = Math.min((pageWidth - margin * 2) / image.width, (pageHeight - margin * 2) / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;
  output
    .addPage([pageWidth, pageHeight])
    .drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
}

/** 依清單順序合併 PDF 與圖片，回傳新 PDF 的位元組。 */
export async function mergeItems(items: readonly MergeItem[], imageMode: ImagePageMode): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  for (const item of items) {
    if (item.kind !== 'pdf') {
      await addImagePage(output, item, imageMode);
      continue;
    }
    const source = await loadPdfDocument(item.bytes, item.file.name);
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach((page) => output.addPage(page));
  }
  return output.save();
}

/** 依頁碼組（1 起算）各產生一份 PDF。 */
export async function buildSplitFiles(
  bytes: Uint8Array,
  fileName: string,
  groups: readonly number[][],
  mode: SplitMode,
): Promise<OutputPdfFile[]> {
  const source = await loadPdfDocument(bytes, fileName);
  const base = safeFilename(baseName(fileName));
  const files: OutputPdfFile[] = [];
  for (const group of groups) {
    const output = await PDFDocument.create();
    const pages = await output.copyPages(source, group.map((n) => n - 1));
    pages.forEach((page) => output.addPage(page));
    const suffix = mode === 'extract' ? '擷取' : groupLabel(group);
    files.push({ name: `${base}_${suffix}.pdf`, bytes: await output.save() });
  }
  return files;
}

/** 依整理後的頁序輸出新 PDF；旋轉角度疊加在原頁面既有的旋轉上。 */
export async function buildOrganizedPdf(
  bytes: Uint8Array,
  fileName: string,
  order: readonly OrganizedPage[],
): Promise<Uint8Array> {
  const original = await loadPdfDocument(bytes, fileName);
  const output = await PDFDocument.create();
  const copied = await output.copyPages(original, order.map((p) => p.sourceIndex));
  copied.forEach((page, i) => {
    page.setRotation(degrees((page.getRotation().angle + order[i].rotation) % 360));
    output.addPage(page);
  });
  return output.save();
}

export function pdfBlob(bytes: Uint8Array): Blob {
  // 複製成獨立的 ArrayBuffer，避免 TS 對 SharedArrayBuffer 的型別抱怨，也不受原陣列後續變動影響。
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
}

/** 單檔直接給 PDF，多檔打包成 ZIP；回傳要下載的內容與檔名。 */
export async function packageSplitFiles(
  files: readonly OutputPdfFile[],
  sourceName: string,
): Promise<{ blob: Blob; filename: string }> {
  if (files.length === 1) return { blob: pdfBlob(files[0].bytes), filename: files[0].name };
  const zip = new JSZip();
  files.forEach((file) => zip.file(file.name, file.bytes));
  try {
    return { blob: await zip.generateAsync({ type: 'blob' }), filename: `${safeFilename(baseName(sourceName))}_拆分.zip` };
  } catch (error) {
    throw new Error(`打包 ZIP 失敗：${(error as Error).message}`);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻釋放的話部分瀏覽器會來不及開始下載。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
