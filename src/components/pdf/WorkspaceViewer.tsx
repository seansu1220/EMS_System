/**
 * PDF 工作區右側的大圖：顯示目前選的那一頁（含旋轉與標記），選了標記工具就能直接在上面拖曳框選。
 * 標記存成「原方向」座標；這裡負責畫面方向 ↔ 原方向的換算，使用者轉頁面時標記會跟著轉。
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { PDF_EDIT_CONFIG, PDF_WORKSPACE_CONFIG } from '../../config/pdfTools';
import { isMarkTooSmall, markToDisplay, normalizeRotation, rectFromPoints, rectToBase, rotatedSize } from '../../lib/pdfEditLogic';
import { paintMarks } from '../../lib/pdfMarkPaint';
import { renderPageToCanvas } from '../../lib/pdfRender';
import type { EditTool, NormRect, WorkPage, WorkSource } from '../../types/pdfTools';

type Point = { x: number; y: number };

const MARK_OUTLINES = { blackout: 'border-slate-400', mosaic: 'border-sky-500', highlight: 'border-amber-500' } as const;

/** 大圖底圖（依絕對旋轉角度畫好），最近看過的幾張留著，切回來不用重畫。 */
function useViewerBase(source: WorkSource, page: WorkPage) {
  const cache = useRef(new Map<string, HTMLCanvasElement>());
  const [base, setBase] = useState<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const absoluteRotation = normalizeRotation(source.baseRotations[page.sourcePageIndex] + page.rotation);
  const key = `${source.id}:${page.sourcePageIndex}:${absoluteRotation}`;

  useEffect(() => {
    const cached = cache.current.get(key);
    if (cached) {
      setBase({ key, canvas: cached });
      return;
    }
    let cancelled = false;
    const size = rotatedSize(source.pageSizes[page.sourcePageIndex], page.rotation);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (PDF_WORKSPACE_CONFIG.viewerRenderWidth * pixelRatio) / Math.max(size.width, size.height);
    renderPageToCanvas(source.preview, page.sourcePageIndex + 1, scale, absoluteRotation)
      .then((canvas) => {
        if (cancelled) return;
        cache.current.set(key, canvas);
        if (cache.current.size > PDF_WORKSPACE_CONFIG.viewerCacheSize) {
          cache.current.delete(cache.current.keys().next().value as string);
        }
        setBase({ key, canvas });
      })
      .catch((error) => { if (!cancelled) console.error('大圖繪製失敗（WorkspaceViewer）：', error); });
    return () => { cancelled = true; };
  }, [key, source, page.sourcePageIndex, page.rotation, absoluteRotation]);

  return base?.key === key ? base.canvas : null;
}

/** 依容器寬度與視窗高度算出大圖的顯示尺寸（px）。 */
function useViewerSize(aspect: number) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!container) return;
    const update = () =>
      setAvailable({ width: container.clientWidth, height: window.innerHeight * PDF_WORKSPACE_CONFIG.viewerMaxHeightRatio });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [container]);
  const width = Math.max(0, Math.min(available.width, available.height * aspect));
  return { setContainer, width, height: width / aspect };
}

export function WorkspaceViewer({
  source,
  page,
  pageNumber,
  pageTotal,
  tool,
  highlightColor,
  onStep,
  onAddMark,
  onRemoveMark,
}: {
  source: WorkSource;
  page: WorkPage;
  pageNumber: number;
  pageTotal: number;
  tool: EditTool;
  highlightColor: string;
  onStep: (delta: number) => void;
  /** 參數為原方向座標的矩形。 */
  onAddMark: (rect: NormRect, kind: Exclude<EditTool, 'browse'>, color?: string) => void;
  onRemoveMark: (markId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragEnd, setDragEnd] = useState<Point | null>(null);
  const base = useViewerBase(source, page);
  const size = rotatedSize(source.pageSizes[page.sourcePageIndex], page.rotation);
  const { setContainer, width, height } = useViewerSize(size.width / size.height);
  const displayMarks = page.marks.map((mark) => markToDisplay(mark, page.rotation));

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    ctx.drawImage(base, 0, 0);
    paintMarks(ctx, page.marks.map((mark) => markToDisplay(mark, page.rotation)));
  }, [base, page.marks, page.rotation]);

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
    if (!dragStart || tool === 'browse') return;
    const rect = rectFromPoints(dragStart, toPoint(event));
    const box = event.currentTarget.getBoundingClientRect();
    setDragStart(null);
    setDragEnd(null);
    if (isMarkTooSmall(rect, box.width, box.height, PDF_EDIT_CONFIG.minMarkPixels)) return;
    onAddMark(rectToBase(rect, page.rotation), tool, tool === 'highlight' ? highlightColor : undefined);
  }

  const draft = dragStart && dragEnd ? rectFromPoints(dragStart, dragEnd) : null;
  const percent = (value: number) => `${value * 100}%`;
  const box = (rect: NormRect) => ({ left: percent(rect.x), top: percent(rect.y), width: percent(rect.width), height: percent(rect.height) });
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2" data-ws="viewer">
      <div className="flex items-center justify-between gap-2 text-sm text-slate-600">
        <button type="button" className="rounded-md px-2 py-1 hover:bg-slate-100 disabled:opacity-30" disabled={pageNumber <= 1} onClick={() => onStep(-1)} aria-label="上一頁">
          ◀
        </button>
        <span className="min-w-0 truncate text-center">
          第 {pageNumber} / {pageTotal} 頁
          <span className="ml-2 text-xs text-slate-400">
            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: PDF_WORKSPACE_CONFIG.sourceColors[source.colorIndex] }} />
            {source.name} 第 {page.sourcePageIndex + 1} 頁
          </span>
        </span>
        <button type="button" className="rounded-md px-2 py-1 hover:bg-slate-100 disabled:opacity-30" disabled={pageNumber >= pageTotal} onClick={() => onStep(1)} aria-label="下一頁">
          ▶
        </button>
      </div>
      <div ref={setContainer} className="flex w-full justify-center">
        <div className="relative bg-white shadow" style={{ width, height }}>
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          {!base && <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">載入中…</div>}
          <div
            data-ws="mark-layer"
            className="absolute inset-0"
            style={{ touchAction: tool === 'browse' ? 'auto' : 'none', cursor: tool === 'browse' ? 'default' : 'crosshair' }}
            onPointerDown={handlePointerDown}
            onPointerMove={(event) => { if (dragStart) setDragEnd(toPoint(event)); }}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => { setDragStart(null); setDragEnd(null); }}
          >
            {displayMarks.map((mark) => (
              <div key={mark.id} className={`pointer-events-none absolute border border-dashed ${MARK_OUTLINES[mark.kind]}`} style={box(mark)}>
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
            {draft && <div className="pointer-events-none absolute border-2 border-dashed border-red-500 bg-red-500/10" style={box(draft)} />}
          </div>
        </div>
      </div>
    </div>
  );
}
