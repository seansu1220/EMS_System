/**
 * 把一串傷票號碼排成可以直接雙面列印的 A4 PDF。
 *
 * 一張 A4 左右並排兩張傷票，PDF 的頁序是「正面、背面、正面、背面…」。
 * **背面的左右是對調的**：印表機選「雙面列印－長邊翻轉」時，紙翻過來左右會互換，
 * 所以正面左邊那張的背面要畫在背面頁的右邊，印出來才會剛好疊在同一張傷票上。
 *
 * 每一頁先畫在 canvas 上再放進 PDF（中文字用瀏覽器現成的字型畫，不必在 PDF 裡嵌入字型檔）。
 */
import { jsPDF } from 'jspdf';
import { TRIAGE_TAG_LAYOUT } from '../config/triageTag';
import {
  createPen,
  createTriageTagCodeImages,
  drawTriageTagBack,
  drawTriageTagFront,
  type TriageTagCodeImages,
} from './triageTagDraw';

/** 產生進度（每畫完一頁回報一次）。 */
export interface TriageTagPdfProgress {
  donePages: number;
  totalPages: number;
}

const MM_PER_INCH = 25.4;

/** 第 slot 格（0＝左、1＝右）傷票左上角在頁面上的位置（公釐）。 */
function slotOrigin(slot: number): { xMm: number; yMm: number } {
  const { pageWidthMm, pageHeightMm, tagsPerSheet, tagWidthMm, tagHeightMm } = TRIAGE_TAG_LAYOUT;
  const cellWidth = pageWidthMm / tagsPerSheet;
  return {
    xMm: slot * cellWidth + (cellWidth - tagWidthMm) / 2,
    yMm: (pageHeightMm - tagHeightMm) / 2,
  };
}

/** 把一串東西切成每張 A4 一組。 */
function chunkBySheet<T>(items: readonly T[]): T[][] {
  const sheets: T[][] = [];
  for (let index = 0; index < items.length; index += TRIAGE_TAG_LAYOUT.tagsPerSheet) {
    sheets.push(items.slice(index, index + TRIAGE_TAG_LAYOUT.tagsPerSheet));
  }
  return sheets;
}

interface TagOnSheet {
  tagNumber: string;
  codes: TriageTagCodeImages;
}

/** 在一張空白 A4 畫布上畫出一面（正面照順序放，背面左右對調）。 */
function renderSheetSide(canvas: HTMLCanvasElement, tags: TagOnSheet[], side: 'front' | 'back'): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器無法建立繪圖畫布（triageTagPdf.renderSheetSide）');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const pxPerMm = TRIAGE_TAG_LAYOUT.dpi / MM_PER_INCH;
  const lastSlot = TRIAGE_TAG_LAYOUT.tagsPerSheet - 1;
  tags.forEach((tag, index) => {
    const slot = side === 'front' ? index : lastSlot - index;
    const origin = slotOrigin(slot);
    const pen = createPen(ctx, pxPerMm, origin.xMm, origin.yMm);
    if (side === 'front') drawTriageTagFront(pen, tag.codes, tag.tagNumber);
    else drawTriageTagBack(pen, tag.codes, tag.tagNumber);
  });
}

/** 讓出主執行緒一下，畫面（進度文字）才有機會更新。 */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 產生傷票 PDF。
 *
 * @param tagNumbers 依序要印的傷票號碼（例 `H00T010`、`H00T011`）
 * @param onProgress 每畫完一頁呼叫一次（可省略）
 * @throws 號碼清單為空、或繪圖／產生 PDF 失敗時
 */
export async function buildTriageTagPdf(
  tagNumbers: readonly string[],
  onProgress?: (progress: TriageTagPdfProgress) => void,
): Promise<Blob> {
  if (tagNumbers.length === 0) throw new Error('沒有要印的傷票號碼（triageTagPdf.buildTriageTagPdf）');
  const { pageWidthMm, pageHeightMm, dpi, jpegQuality } = TRIAGE_TAG_LAYOUT;
  try {
    // 中文字型要先載入完成，否則第一頁可能用到替代字型。
    await document.fonts?.ready;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((pageWidthMm / MM_PER_INCH) * dpi);
    canvas.height = Math.round((pageHeightMm / MM_PER_INCH) * dpi);

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const sheets = chunkBySheet(tagNumbers);
    const totalPages = sheets.length * 2;
    let donePages = 0;
    for (const sheetNumbers of sheets) {
      const tags = await Promise.all(
        sheetNumbers.map(async (tagNumber) => ({ tagNumber, codes: await createTriageTagCodeImages(tagNumber) })),
      );
      for (const side of ['front', 'back'] as const) {
        renderSheetSide(canvas, tags, side);
        if (donePages > 0) pdf.addPage('a4', 'portrait');
        pdf.addImage(canvas.toDataURL('image/jpeg', jpegQuality), 'JPEG', 0, 0, pageWidthMm, pageHeightMm);
        donePages += 1;
        onProgress?.({ donePages, totalPages });
        await yieldToBrowser();
      }
    }
    return pdf.output('blob');
  } catch (error) {
    throw new Error(`產生傷票 PDF 失敗（triageTagPdf.buildTriageTagPdf）：${(error as Error).message}`);
  }
}

/** 下載用的檔名，例：`測試用傷票_H00T010-H00T019.pdf`。 */
export function triageTagPdfFileName(tagNumbers: readonly string[]): string {
  const first = tagNumbers[0] ?? '';
  const last = tagNumbers[tagNumbers.length - 1] ?? first;
  return `測試用傷票_${first === last ? first : `${first}-${last}`}.pdf`;
}
