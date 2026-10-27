/**
 * 把標記畫到 canvas 上（編輯畫面預覽與輸出共用同一支，畫面看到什麼、輸出就是什麼）。
 * 呼叫前 canvas 上必須已經是乾淨的頁面圖（馬賽克要取用底下的像素）。
 */
import { PDF_EDIT_CONFIG } from '../config/pdfTools';
import { marksForPage } from './pdfEditLogic';
import type { EditMark } from '../types/pdfTools';

/**
 * 把矩形範圍縮小再放大（不平滑），形成馬賽克。
 * 縮小時每次只縮一半，讓每一格是底下像素的平均色；一次縮到底的話瀏覽器只會取樣少數像素，
 * 文字邊緣的彩色反鋸齒會被放大成怪異色塊。
 */
function pixelate(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, block: number): void {
  const targetWidth = Math.max(1, Math.ceil(width / block));
  const targetHeight = Math.max(1, Math.ceil(height / block));
  let source: HTMLCanvasElement = ctx.canvas;
  let region = { x, y, width, height };
  do {
    const step = document.createElement('canvas');
    step.width = Math.max(targetWidth, Math.ceil(region.width / 2));
    step.height = Math.max(targetHeight, Math.ceil(region.height / 2));
    const stepCtx = step.getContext('2d');
    if (!stepCtx) throw new Error('瀏覽器無法建立繪圖區（pdfMarkPaint pixelate）');
    stepCtx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, step.width, step.height);
    source = step;
    region = { x: 0, y: 0, width: step.width, height: step.height };
  } while (region.width > targetWidth || region.height > targetHeight);
  const previousSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, region.width, region.height, x, y, width, height);
  ctx.imageSmoothingEnabled = previousSmoothing;
}

/** 依繪製順序（螢光筆 → 馬賽克 → 塗黑）把某一頁的標記畫上去。 */
export function paintMarks(ctx: CanvasRenderingContext2D, marks: readonly EditMark[], pageIndex: number): void {
  const { width: canvasWidth, height: canvasHeight } = ctx.canvas;
  const block = Math.max(2, Math.round(canvasWidth * PDF_EDIT_CONFIG.mosaicBlockRatio));
  for (const mark of marksForPage(marks, pageIndex)) {
    const x = Math.round(mark.x * canvasWidth);
    const y = Math.round(mark.y * canvasHeight);
    const width = Math.max(1, Math.round(mark.width * canvasWidth));
    const height = Math.max(1, Math.round(mark.height * canvasHeight));
    ctx.save();
    if (mark.kind === 'blackout') {
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, width, height);
    } else if (mark.kind === 'mosaic') {
      pixelate(ctx, x, y, width, height, block);
    } else {
      // 色彩增值：白底變成螢光色、黑字維持黑色，跟真的螢光筆一樣。
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = mark.color ?? PDF_EDIT_CONFIG.highlightColors[0].value;
      ctx.fillRect(x, y, width, height);
    }
    ctx.restore();
  }
}
