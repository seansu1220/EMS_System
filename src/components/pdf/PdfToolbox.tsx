/**
 * PDF 工作區（v1.28 起取代原本的合併／拆分／整理／編輯四個分頁）：
 * 檔案丟進來，所有頁面排成一個清單（第二份接在最後面＝合併），在同一個畫面上
 * 排序、轉向、刪除、塗黑／馬賽克／螢光筆，最後選擇下載方式（全部、勾選的頁、拆分、各檔分開）。
 *
 * 版面：上方檔案列｜左直式工具列｜中頁面清單｜右大圖｜下方下載區（手機寬度時改為上下排列）。
 * 檔案全程只在瀏覽器處理，不會上傳、不寫 Firestore。
 */
import { useEffect, useRef, useState } from 'react';
import { PDF_CONVERT_TIPS, PDF_EDIT_CONFIG, PDF_WORKSPACE_CONFIG } from '../../config/pdfTools';
import { useAuth } from '../../hooks/useAuth';
import { usePdfWorkspace } from '../../hooks/usePdfWorkspace';
import { baseName } from '../../lib/pdfPageLogic';
import { actionTargetIds, countPagesBySource, usageEntryFromPlan } from '../../lib/pdfWorkspace';
import { recordPdfToolUsage } from '../../services/pdfToolUsageService';
import type { EditTool, ImagePageMode, NormRect } from '../../types/pdfTools';
import { Card } from '../ui';
import { StatusLine, type StatusMessage } from './PdfToolParts';
import { WorkspaceExportPanel } from './WorkspaceExportPanel';
import { WorkspaceFileBar } from './WorkspaceFileBar';
import { WorkspacePageList } from './WorkspacePageList';
import { WorkspaceToolbar } from './WorkspaceToolbar';
import { WorkspaceViewer } from './WorkspaceViewer';

/** 滑鼠操作的裝置預設直接塗黑；觸控裝置預設「瀏覽」，才不會一滑就畫出框。 */
const defaultTool = (): EditTool =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches ? 'blackout' : 'browse';

/** 檔案若拖到拖放區外，瀏覽器預設會直接開啟該檔並離開本頁，在此攔下。 */
function usePreventFileDropNavigation() {
  useEffect(() => {
    const blockFileDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', blockFileDrop);
    window.addEventListener('drop', blockFileDrop);
    return () => {
      window.removeEventListener('dragover', blockFileDrop);
      window.removeEventListener('drop', blockFileDrop);
    };
  }, []);
}

/** 鍵盤快速鍵：Ctrl＋Z 復原、Delete 刪除頁面（工作區有顯示、且不是在輸入框打字時才生效）。 */
function useWorkspaceShortcuts(root: HTMLElement | null, onUndo: () => void, onRemove: () => void) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!root || root.offsetParent === null) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        onUndo();
      } else if (event.key === 'Delete') {
        event.preventDefault();
        onRemove();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [root, onUndo, onRemove]);
}

export function PdfToolbox() {
  const { state, dispatch, sources, addFiles, reset } = usePdfWorkspace();
  const { user } = useAuth();
  const [tool, setTool] = useState<EditTool>(defaultTool);
  const [highlightColor, setHighlightColor] = useState<string>(PDF_EDIT_CONFIG.highlightColors[0].value);
  const [imageMode, setImageMode] = useState<ImagePageMode>('a4');
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const markCounter = useRef(0);
  usePreventFileDropNavigation();
  useWorkspaceShortcuts(
    root,
    () => dispatch({ type: 'undo' }),
    () => dispatch({ type: 'remove' }),
  );

  const { pages, currentPageId, selectedIds } = state;
  const pageCounts = countPagesBySource(pages);
  const activeSources = [...sources.values()].filter((source) => (pageCounts.get(source.id) ?? 0) > 0);
  const currentIndex = pages.findIndex((page) => page.id === currentPageId);
  const currentPage = pages[currentIndex];
  const currentSource = currentPage ? sources.get(currentPage.sourceId) : undefined;
  const targets = actionTargetIds(state);
  const defaultName =
    activeSources.length === 1 ? `${baseName(activeSources[0].name)}_已處理` : PDF_WORKSPACE_CONFIG.defaultMergedName;

  async function handleAddFiles(files: File[]) {
    setStatus({ text: '讀取檔案中…', tone: 'info' });
    const { addedPages, skipped } = await addFiles(files, imageMode);
    if (skipped.length > 0) setStatus({ text: `⚠ 以下檔案未加入：${skipped.join('；')}`, tone: 'error' });
    else setStatus({ text: `已加入 ${addedPages} 頁`, tone: 'ok' });
  }

  function handleAddMark(rect: NormRect, kind: Exclude<EditTool, 'browse'>, color?: string) {
    if (!currentPage) return;
    const mark = { id: `m${++markCounter.current}`, kind, ...rect, ...(color ? { color } : {}) };
    dispatch({ type: 'addMark', pageId: currentPage.id, mark });
  }

  return (
    <div ref={setRoot} data-ws="root" className="space-y-4">
      <WorkspaceFileBar
        sources={[...sources.values()]}
        pageCounts={pageCounts}
        imageMode={imageMode}
        onImageModeChange={setImageMode}
        onAddFiles={handleAddFiles}
        onRemoveSource={(sourceId) => dispatch({ type: 'removeSource', sourceId })}
        onReset={() => {
          reset();
          setStatus(null);
        }}
      />
      <StatusLine status={status} />

      {pages.length > 0 && currentPage && currentSource && (
        <>
          <Card className="space-y-3 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span>
                共 <strong className="text-slate-800">{pages.length}</strong> 頁
                {selectedIds.length > 0 && `，已勾選 ${selectedIds.length} 頁`}
              </span>
              <button type="button" className="rounded-md px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50" onClick={() => dispatch({ type: 'selectAll' })}>
                全選
              </button>
              {selectedIds.length > 0 && (
                <button type="button" className="rounded-md px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50" onClick={() => dispatch({ type: 'clearSelection' })}>
                  取消勾選
                </button>
              )}
              <span className="ml-auto hidden text-xs text-slate-400 md:inline">點頁面看大圖・拖曳排序・Ctrl＋Z 復原・Delete 刪除</span>
            </div>
            <div className="flex flex-col gap-3 md:flex-row">
              <WorkspaceToolbar
                tool={tool}
                highlightColor={highlightColor}
                targetLabel={selectedIds.length > 0 ? `勾選的 ${targets.length} 頁` : '目前這頁'}
                canAct={targets.length > 0}
                canUndo={state.history.length > 0}
                onToolChange={setTool}
                onColorChange={setHighlightColor}
                onRotate={(delta) => dispatch({ type: 'rotate', delta })}
                onRemove={() => dispatch({ type: 'remove' })}
                onUndo={() => dispatch({ type: 'undo' })}
              />
              <WorkspacePageList
                pages={pages}
                sources={sources}
                currentPageId={currentPageId}
                selectedIds={selectedIds}
                onShowPage={(pageId) => dispatch({ type: 'setCurrent', pageId })}
                onToggleSelect={(pageId) => dispatch({ type: 'toggleSelect', pageId })}
                onMove={(from, to) => dispatch({ type: 'move', from, to })}
              />
              <WorkspaceViewer
                source={currentSource}
                page={currentPage}
                pageNumber={currentIndex + 1}
                pageTotal={pages.length}
                tool={tool}
                highlightColor={highlightColor}
                onStep={(delta) => dispatch({ type: 'step', delta })}
                onAddMark={handleAddMark}
                onRemoveMark={(markId) => dispatch({ type: 'removeMark', pageId: currentPage.id, markId })}
              />
            </div>
            <p className="text-xs text-slate-500">
              {tool === 'browse'
                ? '要塗黑、打馬賽克或畫螢光筆，先選工具，再到大圖上按住拖曳框出範圍。'
                : '在大圖上按住拖曳框出範圍；點框右上角的 ✕ 可以移除。手機上要捲動畫面請先切回「瀏覽」。'}
            </p>
          </Card>

          <Card>
            <WorkspaceExportPanel
              pages={pages}
              selectedIds={selectedIds}
              sources={sources}
              defaultName={defaultName}
              sourceCount={activeSources.length}
              onExported={(action, plan) => {
                if (user) void recordPdfToolUsage(user, usageEntryFromPlan(action, plan));
              }}
            />
          </Card>
        </>
      )}

      <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        🔒 所有處理都在你的瀏覽器中完成，檔案不會上傳到這個網站或任何伺服器，可安心處理含個資的救護紀錄、公文等文件。
      </p>

      <PdfConvertTips />
    </div>
  );
}

/** 「要變成 PDF 不用印出來再掃描」的各情境做法（內容在 config/pdfTools.ts）。 */
function PdfConvertTips() {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-bold text-slate-800">
        💡 網頁、文件要變成 PDF？不用印出來再掃描
      </summary>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {PDF_CONVERT_TIPS.map((tip) => (
          <div key={tip.title}>
            <h3 className="text-sm font-medium text-slate-700">{tip.title}</h3>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-600">
              {tip.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </details>
  );
}
