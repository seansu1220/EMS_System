/**
 * PDF 工具的檔案處理：讀檔、開檔、圖片轉 PDF、打包 ZIP、下載（使用 pdf-lib 與 JSZip）。
 * 全部在瀏覽器內完成，檔案不會上傳；錯誤一律轉成看得懂的中文訊息往上丟。
 */
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { PDF_TOOLS_CONFIG } from '../config/pdfTools';
import { baseName, safeFilename } from './pdfPageLogic';
import type { ImagePageMode, OutputPdfFile, PdfFileKind } from '../types/pdfTools';

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

/** 圖片轉成一頁 PDF：A4 置中縮放（不放大、四周留白），或依圖片原尺寸。 */
export async function imageToPdfBytes(
  bytes: Uint8Array,
  kind: Exclude<PdfFileKind, 'pdf'>,
  fileName: string,
  mode: ImagePageMode,
): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  let image;
  try {
    image = kind === 'png' ? await output.embedPng(bytes) : await output.embedJpg(bytes);
  } catch {
    throw new Error(`「${fileName}」圖片無法讀取，可能不是真正的 JPG／PNG`);
  }
  if (mode === 'original') {
    output.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return output.save();
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
  return output.save();
}

export function pdfBlob(bytes: Uint8Array): Blob {
  // 複製成獨立的 ArrayBuffer，避免 TS 對 SharedArrayBuffer 的型別抱怨，也不受原陣列後續變動影響。
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
}

/** 單檔直接給 PDF，多檔打包成 ZIP；回傳要下載的內容與檔名。 */
export async function packageFiles(
  files: readonly OutputPdfFile[],
  zipBaseName: string,
): Promise<{ blob: Blob; filename: string }> {
  if (files.length === 1) return { blob: pdfBlob(files[0].bytes), filename: files[0].name };
  const zip = new JSZip();
  const used = new Map<string, number>();
  files.forEach((file) => {
    // 同名檔（例如兩個來源檔同名）加上序號，避免 ZIP 裡互相覆蓋。
    const count = (used.get(file.name) ?? 0) + 1;
    used.set(file.name, count);
    zip.file(count === 1 ? file.name : `${baseName(file.name)}(${count}).pdf`, file.bytes);
  });
  try {
    return { blob: await zip.generateAsync({ type: 'blob' }), filename: `${safeFilename(zipBaseName)}.zip` };
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
