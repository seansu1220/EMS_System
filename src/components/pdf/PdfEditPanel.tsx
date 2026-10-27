/**
 * PDF 工具：編輯。框選做塗黑、馬賽克、螢光筆，輸出新的 PDF。
 * 塗黑／馬賽克的頁面會轉成圖片，底下的文字真的消失；螢光筆的頁面保留文字。
 */
import { useMemo, useRef, useState } from 'react';
import { PDF_ACCEPT, PDF_EDIT_CONFIG, PDF_EDIT_TOOLS } from '../../config/pdfTools';
import { useSinglePdf } from '../../hooks/useSinglePdf';
import { exportEditedPdf } from '../../lib/pdfEditExport';
import { summarizeMarks } from '../../lib/pdfEditLogic';
import { downloadBlob, pdfBlob } from '../../lib/pdfEngine';
import { baseName, formatBytes, safeFilename } from '../../lib/pdfPageLogic';
import { getPageGeometry } from '../../lib/pdfRender';
import type { EditMark, EditTool, PageSize } from '../../types/pdfTools';
import { Button, FieldLabel, INPUT_CLASS } from '../ui';
import { EditablePdfPage, type MarkRect } from './EditablePdfPage';
import { PdfDropzone, StatusLine, type StatusMessage } from './PdfToolParts';

/** 滑鼠操作的裝置預設直接塗黑；觸控裝置預設「瀏覽」，才不會一滑就畫出框。 */
const defaultTool = (): EditTool =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches ? 'blackout' : 'browse';

export function PdfEditPanel() {
  const { source, open } = useSinglePdf();
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [marks, setMarks] = useState<EditMark[]>([]);
  const [tool, setTool] = useState<EditTool>(defaultTool);
  const [highlightColor, setHighlightColor] = useState<string>(PDF_EDIT_CONFIG.highlightColors[0].value);
  const [outputName, setOutputName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const nextMarkId = useRef(1);

  const marksByPage = useMemo(() => {
    const grouped = new Map<number, EditMark[]>();
    marks.forEach((mark) => grouped.set(mark.pageIndex, [...(grouped.get(mark.pageIndex) ?? []), mark]));
    return grouped;
  }, [marks]);
  const summary = useMemo(() => summarizeMarks(marks), [marks]);

  async function handleFiles(files: File[]) {
    setStatus({ text: '讀取中…', tone: 'info' });
    try {
      const loaded = await open(files);
      const sizes: PageSize[] = [];
      for (let page = 1; page <= loaded.pageCount; page++) {
        const { width, height } = await getPageGeometry(loaded.preview, page);
        sizes.push({ width, height });
      }
      setPageSizes(sizes);
      setMarks([]);
      setOutputName(`${baseName(loaded.file.name)}_已編輯`);
      setStatus(null);
    } catch (error) {
      setStatus({ text: `✘ ${(error as Error).message}`, tone: 'error' });
    }
  }

  function addMark(pageIndex: number, rect: MarkRect) {
    if (tool === 'browse') return;
    const id = `m${nextMarkId.current++}`;
    const color = tool === 'highlight' ? highlightColor : undefined;
    setMarks((current) => [...current, { id, pageIndex, kind: tool, ...rect, color }]);
  }

  async function handleExport() {
    if (!source) return;
    setBusy(true);
    setStatus({ text: '處理中，請稍候…', tone: 'info' });
    try {
      const bytes = await exportEditedPdf(source.bytes, source.file.name, source.preview, marks, (done, total) =>
        setStatus({ text: `處理中…第 ${done} / ${total} 頁`, tone: 'info' }),
      );
      const filename = `${safeFilename(outputName)}.pdf`;
      downloadBlob(pdfBlob(bytes), filename);
      setStatus({ text: `✔ 已下載「${filename}」（${formatBytes(bytes.length)}）`, tone: 'ok' });
    } catch (error) {
      console.error('輸出失敗（PdfEditPanel handleExport）：', error);
      setStatus({ text: `✘ 輸出失敗：${(error as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PdfDropzone
        accept={PDF_ACCEPT}
        compact={!!source}
        icon="🖍️"
        title={source ? '換一份 PDF' : '點這裡選擇 PDF，或把檔案拖曳進來'}
        hint="一次處理一份 PDF"
        onFiles={handleFiles}
      />

      {source && pageSizes.length === source.pageCount && (
        <>
          <p className="text-sm text-slate-600">
            <strong className="text-slate-800">{source.file.name}</strong>　共 {source.pageCount} 頁
            {marks.length > 0 && `・已標記 ${summary.markedPages} 頁，共 ${marks.length} 處`}
          </p>

          <EditToolbar
            tool={tool}
            highlightColor={highlightColor}
            canUndo={marks.length > 0}
            onToolChange={setTool}
            onColorChange={setHighlightColor}
            onUndo={() => setMarks((current) => current.slice(0, -1))}
            onClear={() => setMarks([])}
          />

          <div className="max-h-[75vh] space-y-4 overflow-y-auto rounded-lg bg-slate-100 p-3 sm:p-4">
            {pageSizes.map((size, pageIndex) => (
              <EditablePdfPage
                key={`${source.file.name}-${pageIndex}`}
                pdf={source.preview}
                pageIndex={pageIndex}
                size={size}
                marks={marksByPage.get(pageIndex) ?? NO_MARKS}
                tool={tool}
                onAddMark={(rect) => addMark(pageIndex, rect)}
                onRemoveMark={(id) => setMarks((current) => current.filter((mark) => mark.id !== id))}
              />
            ))}
          </div>

          {summary.flattenedPages > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              有 {summary.flattenedPages} 頁用了塗黑或馬賽克，這些頁輸出時會整頁轉成圖片，底下的文字才會真的消失
              （那幾頁的文字之後就不能再選取、搜尋）。其他頁維持原樣。
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <FieldLabel>輸出檔名</FieldLabel>
              <div className="flex items-center gap-1">
                <input className={INPUT_CLASS} value={outputName} onChange={(e) => setOutputName(e.target.value)} />
                <span className="text-sm text-slate-500">.pdf</span>
              </div>
            </div>
            <Button onClick={handleExport} disabled={busy || marks.length === 0}>
              {busy ? '處理中…' : '套用並下載'}
            </Button>
          </div>
        </>
      )}
      <StatusLine status={status} />
    </div>
  );
}

const NO_MARKS: readonly EditMark[] = [];

function EditToolbar({
  tool,
  highlightColor,
  canUndo,
  onToolChange,
  onColorChange,
  onUndo,
  onClear,
}: {
  tool: EditTool;
  highlightColor: string;
  canUndo: boolean;
  onToolChange: (tool: EditTool) => void;
  onColorChange: (color: string) => void;
  onUndo: () => void;
  onClear: () => void;
}) {
  const activeHint = PDF_EDIT_TOOLS.find((item) => item.key === tool)?.hint;
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="編輯工具">
        {PDF_EDIT_TOOLS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={tool === item.key}
            onClick={() => onToolChange(item.key)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              tool === item.key ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
            }`}
          >
            {item.icon} {item.name}
          </button>
        ))}
        {tool === 'highlight' && (
          <div className="flex items-center gap-1" aria-label="螢光筆顏色">
            {PDF_EDIT_CONFIG.highlightColors.map((color) => (
              <button
                key={color.value}
                type="button"
                title={color.name}
                aria-label={`螢光筆顏色：${color.name}`}
                aria-pressed={highlightColor === color.value}
                onClick={() => onColorChange(color.value)}
                className={`h-7 w-7 rounded-full border-2 ${highlightColor === color.value ? 'border-slate-800' : 'border-white'}`}
                style={{ backgroundColor: color.value }}
              />
            ))}
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" className="px-3 py-1.5" disabled={!canUndo} onClick={onUndo}>↶ 復原上一步</Button>
          <Button variant="secondary" className="px-3 py-1.5" disabled={!canUndo} onClick={onClear}>清除全部</Button>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {activeHint}。{tool === 'browse' ? '要開始標記請先選上面的工具。' : '在頁面上按住拖曳拉出框；點框右上角的 ✕ 可以移除。'}
        手機上選了工具後在頁面上滑動會畫框，要捲動請切回「瀏覽」。
      </p>
    </div>
  );
}
