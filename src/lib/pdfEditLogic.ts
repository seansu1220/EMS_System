/**
 * PDF 標記（塗黑／馬賽克／螢光筆）的運算（純函式，不碰 DOM）。
 * 座標一律為頁面上的正規化值 0～1。
 */
import type { MarkKind, NormRect, PageMark } from '../types/pdfTools';

/** 會讓整頁轉成圖片的標記：塗黑、馬賽克（底下的文字必須真的消失）。 */
const FLATTEN_KINDS: readonly MarkKind[] = ['blackout', 'mosaic'];

/** 繪製順序：螢光筆先、馬賽克、最後塗黑，確保遮蔽一定蓋在最上層。 */
const PAINT_ORDER: Record<MarkKind, number> = { highlight: 0, mosaic: 1, blackout: 2 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 兩個拖曳端點（正規化座標）→ 左上角起算的矩形，超出頁面的部分裁掉。 */
export function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): NormRect {
  const left = clamp01(Math.min(start.x, end.x));
  const top = clamp01(Math.min(start.y, end.y));
  const right = clamp01(Math.max(start.x, end.x));
  const bottom = clamp01(Math.max(start.y, end.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 框太小（誤點）就不建立標記。displayWidth／displayHeight 為畫面上的像素尺寸。 */
export function isMarkTooSmall(rect: NormRect, displayWidth: number, displayHeight: number, minPixels: number): boolean {
  return rect.width * displayWidth < minPixels || rect.height * displayHeight < minPixels;
}

/** 依繪製順序排好（同種類維持建立順序）。 */
export function sortMarksForPaint<T extends { kind: MarkKind }>(marks: readonly T[]): T[] {
  return marks
    .map((mark, order) => ({ mark, order }))
    .sort((a, b) => PAINT_ORDER[a.mark.kind] - PAINT_ORDER[b.mark.kind] || a.order - b.order)
    .map(({ mark }) => mark);
}

/** 這一頁是否要轉成圖片輸出（有塗黑或馬賽克）。 */
export function pageNeedsFlatten(marks: readonly PageMark[]): boolean {
  return marks.some((mark) => FLATTEN_KINDS.includes(mark.kind));
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

// ---------- 旋轉換算（使用者在工作區轉頁面時，標記要跟著轉）----------

export const normalizeRotation = (angle: number) => ((angle % 360) + 360) % 360;

/** 原方向的點 → 順時針轉 rotation 度後畫面上的點。 */
function rotatePoint(x: number, y: number, rotation: number): [number, number] {
  switch (normalizeRotation(rotation)) {
    case 90:
      return [1 - y, x];
    case 180:
      return [1 - x, 1 - y];
    case 270:
      return [y, 1 - x];
    default:
      return [x, y];
  }
}

function rotateRect(rect: NormRect, rotation: number): NormRect {
  const [x1, y1] = rotatePoint(rect.x, rect.y, rotation);
  const [x2, y2] = rotatePoint(rect.x + rect.width, rect.y + rect.height, rotation);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** 原方向的矩形 → 畫面上（已加使用者旋轉）的矩形。 */
export const rectToDisplay = (rect: NormRect, rotation: number): NormRect => rotateRect(rect, rotation);

/** 畫面上（已加使用者旋轉）的矩形 → 原方向的矩形。 */
export const rectToBase = (rect: NormRect, rotation: number): NormRect => rotateRect(rect, 360 - normalizeRotation(rotation));

/** 標記換成畫面方向（保留其他欄位）。 */
export const markToDisplay = (mark: PageMark, rotation: number): PageMark => ({ ...mark, ...rectToDisplay(mark, rotation) });

/** 原方向尺寸 → 轉了 rotation 度之後的尺寸。 */
export function rotatedSize(size: { width: number; height: number }, rotation: number) {
  return normalizeRotation(rotation) % 180 === 0 ? size : { width: size.height, height: size.width };
}
