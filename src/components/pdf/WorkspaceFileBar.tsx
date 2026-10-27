/**
 * PDF 工作區上方：已加入的檔案（色點對應頁面清單上的色點，✕ 把該檔的頁全部移出清單）、
 * 加入更多檔案、圖片加入時的頁面大小、全部清空。
 */
import { PDF_WORKSPACE_CONFIG, WORKSPACE_ACCEPT } from '../../config/pdfTools';
import type { ImagePageMode, WorkSource } from '../../types/pdfTools';
import { Button } from '../ui';
import { PdfDropzone } from './PdfToolParts';

export function WorkspaceFileBar({
  sources,
  pageCounts,
  imageMode,
  onImageModeChange,
  onAddFiles,
  onRemoveSource,
  onReset,
}: {
  sources: readonly WorkSource[];
  /** 各來源檔還留在清單上的頁數。 */
  pageCounts: ReadonlyMap<string, number>;
  imageMode: ImagePageMode;
  onImageModeChange: (mode: ImagePageMode) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveSource: (sourceId: string) => void;
  onReset: () => void;
}) {
  const visible = sources.filter((source) => (pageCounts.get(source.id) ?? 0) > 0);
  const empty = visible.length === 0;
  return (
    <div className="space-y-2">
      <PdfDropzone
        accept={WORKSPACE_ACCEPT}
        multiple
        compact={!empty}
        icon="📂"
        title={empty ? '點這裡選擇 PDF 或圖片，或把檔案拖曳進來' : '＋ 加入更多 PDF 或圖片（接在最後面）'}
        hint="可一次選多個，支援 PDF、JPG、PNG；之後還可以隨時再加"
        onFiles={onAddFiles}
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {visible.map((source) => (
          <span key={source.id} data-ws="source-chip" className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1 pl-2.5 pr-1">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PDF_WORKSPACE_CONFIG.sourceColors[source.colorIndex] }} />
            <span className="min-w-0 truncate text-slate-700">{source.name}</span>
            <span className="shrink-0 text-xs text-slate-500">{pageCounts.get(source.id)} 頁</span>
            <button
              type="button"
              aria-label={`移除 ${source.name}`}
              title="把這個檔案的頁全部移出清單"
              className="h-6 w-6 shrink-0 rounded-full text-xs text-slate-500 hover:bg-red-50 hover:text-red-600"
              onClick={() => onRemoveSource(source.id)}
            >
              ✕
            </button>
          </span>
        ))}
        <label className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500">
          加入圖片時
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
            value={imageMode}
            onChange={(e) => onImageModeChange(e.target.value as ImagePageMode)}
          >
            <option value="a4">放進 A4 頁面</option>
            <option value="original">依圖片原尺寸</option>
          </select>
        </label>
        {!empty && (
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onReset}>
            全部清空
          </Button>
        )}
      </div>
    </div>
  );
}
