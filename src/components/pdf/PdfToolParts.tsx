/**
 * PDF 工具三個分頁共用的顯示元件：拖放選檔區、頁面縮圖、狀態訊息。
 * 純顯示與事件捕捉，不含 PDF 處理邏輯。
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { PDF_TOOLS_CONFIG } from '../../config/pdfTools';
import { renderPageThumbnail, type PDFDocumentProxy } from '../../lib/pdfRender';

// ---------- 拖放選檔區 ----------

export function PdfDropzone({
  accept,
  multiple = false,
  compact = false,
  icon,
  title,
  hint,
  onFiles,
}: {
  accept: string;
  multiple?: boolean;
  /** 已選好檔案後縮小顯示，讓出空間給工作區。 */
  compact?: boolean;
  icon: string;
  title: string;
  hint: string;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) onFiles([...event.dataTransfer.files]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    inputRef.current?.click();
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={title}
        onClick={() => inputRef.current?.click()}
        onKeyDown={handleKeyDown}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`cursor-pointer rounded-xl border-2 border-dashed text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
          dragging ? 'border-slate-600 bg-slate-100' : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50'
        } ${compact ? 'px-4 py-3' : 'px-4 py-10'}`}
      >
        <div className={compact ? 'inline text-lg' : 'text-4xl'}>{icon}</div>
        <div className={`font-medium text-slate-700 ${compact ? 'ml-2 inline text-sm' : 'mt-2'}`}>{title}</div>
        {!compact && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files]);
          e.target.value = ''; // 同一個檔案再選一次也要觸發
        }}
      />
    </>
  );
}

// ---------- 狀態訊息 ----------

export type StatusTone = 'info' | 'ok' | 'error';
export interface StatusMessage {
  text: string;
  tone: StatusTone;
}

const STATUS_TONES: Record<StatusTone, string> = {
  info: 'text-slate-600',
  ok: 'text-green-700',
  error: 'text-red-600',
};

export function StatusLine({ status }: { status: StatusMessage | null }) {
  return (
    <p aria-live="polite" className={`min-h-5 text-sm ${status ? STATUS_TONES[status.tone] : ''}`}>
      {status?.text}
    </p>
  );
}

// ---------- 頁面縮圖 ----------

/** 旋轉後要塞進固定框內的縮放比例（純函式）。 */
function fitScale(size: { width: number; height: number }, rotation: number): number {
  const boxWidth = PDF_TOOLS_CONFIG.thumbWidth;
  const boxHeight = boxWidth * PDF_TOOLS_CONFIG.thumbBoxRatio;
  const sideways = rotation % 180 !== 0;
  const [width, height] = sideways ? [size.height, size.width] : [size.width, size.height];
  return Math.min(1, boxWidth / width, boxHeight / height);
}

/**
 * 單頁縮圖：捲到附近才繪製（大檔案不會一次畫幾百頁），只畫一次；
 * 旋轉用 CSS 呈現，不重畫。
 */
export function PdfThumbnail({
  pdf,
  pageNumber,
  rotation = 0,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  rotation?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        renderPageThumbnail(pdf, pageNumber, canvas, PDF_TOOLS_CONFIG.thumbWidth)
          .then((rendered) => { if (!cancelled) setSize(rendered); })
          .catch((error) => {
            if (cancelled) return; // 換檔時舊文件被關閉，繪製中斷屬正常
            console.error(`縮圖繪製失敗（PdfThumbnail 第 ${pageNumber} 頁）：`, error);
            setFailed(true);
          });
      },
      { rootMargin: PDF_TOOLS_CONFIG.thumbPreloadMargin },
    );
    observer.observe(box);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [pdf, pageNumber]);

  const scale = size ? fitScale(size, rotation) : 1;
  return (
    <div
      ref={boxRef}
      className="mx-auto flex items-center justify-center overflow-hidden rounded bg-slate-100"
      style={{
        width: PDF_TOOLS_CONFIG.thumbWidth,
        height: PDF_TOOLS_CONFIG.thumbWidth * PDF_TOOLS_CONFIG.thumbBoxRatio,
      }}
    >
      {failed && <span className="text-xs text-slate-400">無法預覽</span>}
      <canvas
        ref={canvasRef}
        className={`max-w-none shrink-0 bg-white shadow-sm transition-transform ${failed ? 'hidden' : ''}`}
        style={{ transform: `rotate(${rotation}deg) scale(${scale})` }}
      />
    </div>
  );
}

// ---------- 小圖示按鈕（上移、旋轉、刪除…）----------

export function RowIconButton({
  title,
  danger = false,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`h-8 w-8 shrink-0 rounded-md border border-slate-200 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}
