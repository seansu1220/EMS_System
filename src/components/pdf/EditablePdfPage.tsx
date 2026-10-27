/**
 * 編輯分頁中的單一頁面：底圖捲到附近才畫，標記一變就從乾淨底圖重畫（與輸出共用 paintMarks），
 * 上面一層透明圖層負責框選與刪除標記。
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { PDF_EDIT_CONFIG } from '../../config/pdfTools';
import { isMarkTooSmall, rectFromPoints } from '../../lib/pdfEditLogic';
import { paintMarks } from '../../lib/pdfMarkPaint';
import { renderPageToCanvas, type PDFDocumentProxy } from '../../lib/pdfRender';
import type { EditMark, EditTool, PageSize } from '../../types/pdfTools';

type Point = { x: number; y: number };
export type MarkRect = { x: number; y: number; width: number; height: number };

const MARK_OUTLINES: Record<EditMark['kind'], string> = {
  blackout: 'border-slate-400',
  mosaic: 'border-sky-500',
  highlight: 'border-amber-500',
};

/** 底圖：進入畫面附近才以固定解析度畫一次。 */
function useBaseCanvas(pdf: PDFDocumentProxy, pageIndex: number, size: PageSize, target: HTMLElement | null) {
  const [base, setBase] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const scale = (PDF_EDIT_CONFIG.maxDisplayWidth * pixelRatio) / size.width;
      renderPageToCanvas(pdf, pageIndex + 1, scale)
        .then((canvas) => { if (!cancelled) setBase(canvas); })
        .catch((error) => { if (!cancelled) console.error(`頁面繪製失敗（EditablePdfPage 第 ${pageIndex + 1} 頁）：`, error); });
    });
    observer.observe(target);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [pdf, pageIndex, size.width, target]);
  return base;
}

export function EditablePdfPage({
  pdf,
  pageIndex,
  size,
  marks,
  tool,
  onAddMark,
  onRemoveMark,
}: {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  size: PageSize;
  /** 只含這一頁的標記。 */
  marks: readonly EditMark[];
  tool: EditTool;
  onAddMark: (rect: MarkRect) => void;
  onRemoveMark: (id: string) => void;
}) {
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragEnd, setDragEnd] = useState<Point | null>(null);
  const base = useBaseCanvas(pdf, pageIndex, size, wrapper);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    ctx.drawImage(base, 0, 0);
    paintMarks(ctx, marks, pageIndex);
  }, [base, marks, pageIndex]);

  function toPoint(event: PointerEvent<HTMLDivElement>): Point {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (tool === 'browse' || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toPoint(event);
    setDragStart(point);
    setDragEnd(point);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    const rect = rectFromPoints(dragStart, toPoint(event));
    const box = event.currentTarget.getBoundingClientRect();
    setDragStart(null);
    setDragEnd(null);
    if (!isMarkTooSmall(rect, box.width, box.height, PDF_EDIT_CONFIG.minMarkPixels)) onAddMark(rect);
  }

  const draft = dragStart && dragEnd ? rectFromPoints(dragStart, dragEnd) : null;
  const percent = (value: number) => `${value * 100}%`;
  return (
    <div>
      <div className="mb-1 text-xs text-slate-500">第 {pageIndex + 1} 頁</div>
      <div
        ref={setWrapper}
        data-page-index={pageIndex}
        className="relative w-full bg-white shadow"
        style={{ maxWidth: PDF_EDIT_CONFIG.maxDisplayWidth, aspectRatio: `${size.width} / ${size.height}` }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {!base && <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">載入中…</div>}
        <div
          data-mark-layer
          className="absolute inset-0"
          style={{ touchAction: tool === 'browse' ? 'auto' : 'none', cursor: tool === 'browse' ? 'default' : 'crosshair' }}
          onPointerDown={handlePointerDown}
          onPointerMove={(event) => { if (dragStart) setDragEnd(toPoint(event)); }}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => { setDragStart(null); setDragEnd(null); }}
        >
          {marks.map((mark) => (
            <div
              key={mark.id}
              className={`pointer-events-none absolute border border-dashed ${MARK_OUTLINES[mark.kind]}`}
              style={{ left: percent(mark.x), top: percent(mark.y), width: percent(mark.width), height: percent(mark.height) }}
            >
              <button
                type="button"
                title="移除這個標記"
                aria-label="移除這個標記"
                className="pointer-events-auto absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] text-white shadow hover:bg-red-500"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onRemoveMark(mark.id)}
              >
                ✕
              </button>
            </div>
          ))}
          {draft && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-red-500 bg-red-500/10"
              style={{ left: percent(draft.x), top: percent(draft.y), width: percent(draft.width), height: percent(draft.height) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
