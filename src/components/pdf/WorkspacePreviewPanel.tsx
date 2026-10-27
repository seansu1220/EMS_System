/**
 * 側邊預覽面板（v1.30，仿 Claude 開檔的預覽）：點頁面時大圖從視窗右側滑出。
 * - 電腦寬度：面板貼齊視窗右側、從上到下，整個網站往左讓出空間；左緣可拖曳調寬（雙擊恢復預設），寬度比例記在這台瀏覽器。
 * - 手機寬度：蓋滿整個畫面，上方附工具列（才選得到塗黑等工具）。
 * 關閉時仍保持掛載（滑進滑出才有動畫），以 inert 讓它不被點到、不被鍵盤選到。
 * 用 portal 掛到 body，才不受小工具頁內容寬度限制。
 */
import { useEffect, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PDF_PREVIEW_PANEL_CONFIG as PANEL } from '../../config/pdfTools';
import { clampPanelWidth } from '../../lib/pdfWorkspace';

function readSavedRatio(): number {
  try {
    const saved = Number(window.localStorage.getItem(PANEL.storageKey));
    return saved > 0 && saved < 1 ? saved : PANEL.defaultRatio;
  } catch {
    return PANEL.defaultRatio; // 無痕視窗等情況讀不到，用預設值
  }
}

function saveRatio(ratio: number) {
  try {
    window.localStorage.setItem(PANEL.storageKey, ratio.toFixed(3));
  } catch {
    // 存不了只是下次回到預設寬度，不影響使用
  }
}

/** 視窗內容寬度（不含捲軸，與 fixed 定位的右緣一致）。 */
function useViewportWidth(): number {
  const read = () => document.documentElement.clientWidth;
  const [width, setWidth] = useState(read);
  useEffect(() => {
    const update = () => setWidth(read());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

/** 並排時把 body 右側讓出面板寬度（整個網站往左縮）；關閉、離開頁面時還原。 */
function useBodyPush(pushWidth: number, animate: boolean) {
  useEffect(() => {
    const style = document.body.style;
    style.transition = animate ? `padding-right ${PANEL.slideMs}ms ease` : '';
    style.paddingRight = pushWidth > 0 ? `${pushWidth}px` : '';
  }, [pushWidth, animate]);
  useEffect(
    () => () => {
      document.body.style.paddingRight = '';
      document.body.style.transition = '';
    },
    [],
  );
}

export function WorkspacePreviewPanel({
  open,
  toolbar,
  children,
}: {
  open: boolean;
  /** 手機寬度時顯示在大圖上方的工具列。 */
  toolbar: ReactNode;
  /** 大圖（WorkspaceViewer）。 */
  children: ReactNode;
}) {
  const viewportWidth = useViewportWidth();
  const sideBySide = viewportWidth >= PANEL.sideBySideMinWidth;
  const [ratio, setRatio] = useState(readSavedRatio);
  const [resizing, setResizing] = useState(false);
  const width = sideBySide ? clampPanelWidth(ratio * viewportWidth, viewportWidth, PANEL) : viewportWidth;
  useBodyPush(open && sideBySide ? width : 0, !resizing);

  function handleResizeMove(event: PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    setRatio(clampPanelWidth(viewportWidth - event.clientX, viewportWidth, PANEL) / viewportWidth);
  }

  function handleResizeEnd() {
    if (!resizing) return;
    setResizing(false);
    saveRatio(ratio);
  }

  return createPortal(
    <aside
      data-ws="preview-panel"
      data-open={open ? 'true' : 'false'}
      aria-label="頁面預覽"
      inert={!open}
      className={`fixed inset-y-0 right-0 flex flex-col bg-white ${sideBySide ? 'z-30 border-l border-slate-200 shadow-2xl' : 'z-40'}`}
      style={{
        width,
        transform: open ? 'none' : 'translateX(100%)',
        visibility: open ? 'visible' : 'hidden',
        transition: resizing ? 'none' : `transform ${PANEL.slideMs}ms ease, visibility ${PANEL.slideMs}ms`,
      }}
    >
      {sideBySide && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖曳調整預覽寬度"
          title="拖曳調整寬度，雙擊恢復預設"
          data-ws="panel-resizer"
          className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-sky-400/40 ${resizing ? 'bg-sky-400/60' : ''}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={() => {
            setRatio(PANEL.defaultRatio);
            saveRatio(PANEL.defaultRatio);
          }}
        />
      )}
      {!sideBySide && <div className="border-b border-slate-200 p-2">{toolbar}</div>}
      <div className="flex min-h-0 flex-1 flex-col p-3">{children}</div>
    </aside>,
    document.body,
  );
}
