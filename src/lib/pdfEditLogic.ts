/**
 * PDF 編輯（塗黑／馬賽克／螢光筆）的標記運算（純函式，不碰 DOM）。
 * 座標一律為頁面上的正規化值 0～1（已套用頁面旋轉，就是畫面上看到的方向）。
 */
import type { EditMark, MarkKind } from '../types/pdfTools';

/** 會讓整頁轉成圖片的標記：塗黑、馬賽克（底下的文字必須真的消失）。 */
const FLATTEN_KINDS: readonly MarkKind[] = ['blackout', 'mosaic'];

/** 繪製順序：螢光筆先、馬賽克、最後塗黑，確保遮蔽一定蓋在最上層。 */
const PAINT_ORDER: Record<MarkKind, number> = { highlight: 0, mosaic: 1, blackout: 2 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 兩個拖曳端點（正規化座標）→ 左上角起算的矩形，超出頁面的部分裁掉。 */
export function rectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  const left = clamp01(Math.min(start.x, end.x));
  const top = clamp01(Math.min(start.y, end.y));
  const right = clamp01(Math.max(start.x, end.x));
  const bottom = clamp01(Math.max(start.y, end.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 框太小（誤點）就不建立標記。displayWidth／displayHeight 為畫面上的像素尺寸。 */
export function isMarkTooSmall(
  rect: { width: number; height: number },
  displayWidth: number,
  displayHeight: number,
  minPixels: number,
): boolean {
  return rect.width * displayWidth < minPixels || rect.height * displayHeight < minPixels;
}

/** 某一頁的標記，依繪製順序排好（同種類維持建立順序）。 */
export function marksForPage(marks: readonly EditMark[], pageIndex: number): EditMark[] {
  return marks
    .filter((mark) => mark.pageIndex === pageIndex)
    .map((mark, order) => ({ mark, order }))
    .sort((a, b) => PAINT_ORDER[a.mark.kind] - PAINT_ORDER[b.mark.kind] || a.order - b.order)
    .map(({ mark }) => mark);
}

/** 這一頁是否要轉成圖片輸出（有塗黑或馬賽克）。 */
export function pageNeedsFlatten(pageMarks: readonly EditMark[]): boolean {
  return pageMarks.some((mark) => FLATTEN_KINDS.includes(mark.kind));
}

/** 統計：幾頁有標記、其中幾頁會轉成圖片。 */
export function summarizeMarks(marks: readonly EditMark[]): { markedPages: number; flattenedPages: number } {
  const pages = new Map<number, EditMark[]>();
  marks.forEach((mark) => pages.set(mark.pageIndex, [...(pages.get(mark.pageIndex) ?? []), mark]));
  const flattenedPages = [...pages.values()].filter(pageNeedsFlatten).length;
  return { markedPages: pages.size, flattenedPages };
}

/** 依倍率算出轉圖片的實際倍率，長邊不超過上限。 */
export function cappedScale(pageWidth: number, pageHeight: number, scale: number, maxSide: number): number {
  return Math.min(scale, maxSide / Math.max(pageWidth, pageHeight));
}

/** 十六進位色碼 → 0～1 的 RGB（給 pdf-lib 用）；格式不對時回傳黃色。 */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return { r: 1, g: 0.88, b: 0.28 };
  return { r: parseInt(match[1], 16) / 255, g: parseInt(match[2], 16) / 255, b: parseInt(match[3], 16) / 255 };
}
