/**
 * PDF 工作區右側的大圖：顯示目前選的那一頁（含旋轉與標記），選了標記工具就能直接在上面拖曳框選。
 * 預設「符合寬度」：頁面撐滿右側寬度，比畫面高時在大圖區塊內捲動；另可切整頁、＋／－ 縮放。
 * 標記存成「原方向」座標；這裡負責畫面方向 ↔ 原方向的換算，使用者轉頁面時標記會跟著轉。
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { PDF_EDIT_CONFIG, PDF_WORKSPACE_CONFIG } from '../../config/pdfTools';
import { isMarkTooSmall, markToDisplay, normalizeRotation, rectFromPoints, rectToBase, rotatedSize } from '../../lib/pdfEditLogic';
import { paintMarks } from '../../lib/pdfMarkPaint';
import { renderPageToCanvas } from '../../lib/pdfRender';
import { stepZoom, viewerDisplayWidth, zoomFactor, type ViewerZoom } from '../../lib/pdfWorkspace';
import type { EditTool, NormRect, WorkPage, WorkSource } from '../../types/pdfTools';

type Point = { x: number; y: number };

const MARK_OUTLINES = { blackout: 'border-slate-400', mosaic: 'border-sky-500', highlight: 'border-amber-500' } as const;

/**
 * 大圖底圖：依絕對旋轉角度、以「顯示寬度×裝置像素比」往上取整的解析度畫好；
 * 已畫過的若解析度夠就直接用（放大才重畫），最近幾張留著。
 */
function useViewerBase(source: WorkSource, page: WorkPage, displayWidth: number) {
  const cache = useRef(new Map<string, HTMLCanvasElement>());
  const [base, setBase] = useState<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const absoluteRotation = normalizeRotation(source.baseRotations[page.sourcePageIndex] + page.rotation);
  const pageKey = `${source.id}:${page.sourcePageIndex}:${absoluteRotation}`;
  const size = rotatedSize(source.pageSizes[page.sourcePageIndex], page.rotation);
  const { viewerRenderBucket: bucket, viewerMaxRenderSide: maxSide } = PDF_WORKSPACE_CONFIG;
  const wantedWidth = Math.ceil((Math.max(displayWidth, 1) * Math.min(window.devicePixelRatio || 1, 2)) / bucket) * bucket;
  const scale = Math.min(wantedWidth / size.width, maxSide / Math.max(size.width, size.height));
  const renderKey = `${pageKey}@${Math.round(scale * size.width)}`;

  useEffect(() => {
    const cached = cache.current.get(pageKey);
    if (cached && cached.width >= Math.floor(scale * size.width) - 1) {
      setBase({ key: pageKey, canvas: cached });
      return;
    }
    if (cached) setBase({ key: pageKey, canvas: cached }); // 先顯示較模糊的，畫好再換
    let cancelled = false;
    renderPageToCanvas(source.preview, page.sourcePageIndex + 1, scale, absoluteRotation)
      .then((canvas) => {
        if (cancelled) return;
        cache.current.delete(pageKey);
        cache.current.set(pageKey, canvas);
        if (cache.current.size > PDF_WORKSPACE_CONFIG.viewerCacheSize) {
          cache.current.delete(cache.current.keys().next().value as string);
        }
        setBase({ key: pageKey, canvas });
      })
      .catch((error) => { if (!cancelled) console.error('大圖繪製失敗（WorkspaceViewer）：', error); });
    return () => { cancelled = true; };
    // renderKey 已涵蓋頁、角度與解析度的變化，其餘值都由它推得。
  }, [renderKey]);

  return base?.key === pageKey ? base.canvas : null;
}

/** 大圖區塊可用的寬高（px）：寬＝區塊內寬，高＝視窗高度扣掉上方區域。 */
function useAvailableArea() {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!frame) return;
    const update = () =>
      setArea({ width: frame.clientWidth, height: Math.max(240, window.innerHeight - PDF_WORKSPACE_CONFIG.viewerHeightOffset) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [frame]);
  return { setFrame, ...area };
}

function ZoomControls({ zoom, factor, onChange }: { zoom: ViewerZoom; factor: number; onChange: (zoom: ViewerZoom) => void }) {
  const steps = PDF_WORKSPACE_CONFIG.zoomSteps;
  const button = (active: boolean) =>
    `rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-30 ${
      active ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
    }`;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1" role="group" aria-label="大圖縮放">
      <button type="button" className={button(zoom === 'page')} onClick={() => onChange('page')}>整頁</button>
      <button type="button" className={button(zoom === 'width')} onClick={() => onChange('width')}>符合寬度</button>
      <button type="button" className={button(false)} aria-label="縮小" disabled={factor <= steps[0] + 0.001} onClick={() => onChange(stepZoom(factor, -1, steps))}>－</button>
      <span className="w-12 text-center text-xs tabular-nums text-slate-600" data-ws="zoom-level">{Math.round(factor * 100)}%</span>
      <button type="button" className={button(false)} aria-label="放大" disabled={factor >= steps[steps.length - 1] - 0.001} onClick={() => onChange(stepZoom(factor, 1, steps))}>＋</button>
    </div>
  );
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
  const [zoom, setZoom] = useState<ViewerZoom>('width');
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragEnd, setDragEnd] = useState<Point | null>(null);
  const size = rotatedSize(source.pageSizes[page.sourcePageIndex], page.rotation);
  const aspect = size.width / size.height;
  const { setFrame, width: areaWidth, height: areaHeight } = useAvailableArea();
  const width = viewerDisplayWidth(zoom, areaWidth, areaHeight, aspect);
  const height = width / aspect;
  const base = useViewerBase(source, page, width);
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" className="rounded-md px-2 py-1 hover:bg-slate-100 disabled:opacity-30" disabled={pageNumber <= 1} onClick={() => onStep(-1)} aria-label="上一頁">
            ◀
          </button>
          <span className="min-w-0 truncate">
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
        <ZoomControls zoom={zoom} factor={zoomFactor(zoom, areaWidth, areaHeight, aspect)} onChange={setZoom} />
      </div>
      <div
        ref={setFrame}
        data-ws="viewer-frame"
        className="w-full overflow-auto rounded-lg bg-slate-100"
        // 固定保留捲軸位置：否則捲軸一出現寬度就變窄、「符合寬度」又重算，可能來回跳動。
        style={{ maxHeight: areaHeight || undefined, scrollbarGutter: 'stable' }}
      >
        {/* 頁面比區塊窄時置中；放大後比區塊寬時從左邊開始，才捲得到左緣。 */}
        <div className="relative mx-auto bg-white shadow" style={{ width, height }}>
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
