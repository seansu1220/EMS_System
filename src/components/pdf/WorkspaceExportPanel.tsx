/**
 * PDF 工作區下方的下載區：全部合成一份、只下載勾選的頁、各檔分開下載、拆分成多個檔案。
 * 決定「產生哪些檔」的規劃在 lib/pdfWorkspace.ts（純函式），實際產生在 lib/pdfWorkspaceExport.ts。
 */
import { useMemo, useState } from 'react';
import { buildOutputFiles } from '../../lib/pdfWorkspaceExport';
import { downloadBlob, packageFiles } from '../../lib/pdfEngine';
import { buildSplitGroups, describeSplitGroups, formatBytes } from '../../lib/pdfPageLogic';
import {
  planAllPages,
  planPerSource,
  planSelectedPages,
  planSplit,
  summarizePages,
  type ExportPlan,
} from '../../lib/pdfWorkspace';
import type { SplitMode, WorkPage, WorkSource } from '../../types/pdfTools';
import type { PdfUsageAction } from '../../types/pdfToolUsage';
import { Button, FieldLabel, INPUT_CLASS } from '../ui';
import { StatusLine, type StatusMessage } from './PdfToolParts';

export function WorkspaceExportPanel({
  pages,
  selectedIds,
  sources,
  defaultName,
  sourceCount,
  onExported,
}: {
  pages: readonly WorkPage[];
  selectedIds: readonly string[];
  sources: ReadonlyMap<string, WorkSource>;
  defaultName: string;
  /** 清單上的頁來自幾個檔案。 */
  sourceCount: number;
  /** 下載成功後通知（記使用紀錄用）。 */
  onExported: (action: PdfUsageAction, plan: ExportPlan) => void;
}) {
  const [outputName, setOutputName] = useState('');
  const [splitMode, setSplitMode] = useState<SplitMode>('ranges');
  const [rangeText, setRangeText] = useState('');
  const [everyN, setEveryN] = useState('2');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const name = outputName.trim() || defaultName;
  const summary = summarizePages(pages);
  const split = useMemo(() => buildSplitGroups(splitMode, rangeText, everyN, pages.length), [splitMode, rangeText, everyN, pages.length]);

  async function runExport(action: PdfUsageAction, plan: ExportPlan) {
    setBusy(true);
    setStatus({ text: '處理中，請稍候…', tone: 'info' });
    try {
      const files = await buildOutputFiles(plan.groups, sources, (done, total) =>
        setStatus({ text: `處理中…第 ${done} / ${total} 頁`, tone: 'info' }),
      );
      const { blob, filename } = await packageFiles(files, plan.zipName);
      downloadBlob(blob, filename);
      setStatus({ text: `✔ 已下載「${filename}」（${formatBytes(blob.size)}）`, tone: 'ok' });
      onExported(action, plan);
    } catch (error) {
      console.error('下載失敗（WorkspaceExportPanel runExport）：', error);
      setStatus({ text: `✘ 下載失敗：${(error as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = pages.filter((page) => selectedIds.includes(page.id)).length;
  const sourceNames = new Map([...sources.values()].map((source) => [source.id, source.name]));
  return (
    <div className="space-y-3" data-ws="export">
      {summary.flattenedPages > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          有 {summary.flattenedPages} 頁用了塗黑或馬賽克，這些頁下載時會整頁轉成圖片，底下的文字才會真的消失
          （那幾頁的文字之後就不能再選取、搜尋）。其他頁維持原樣。
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-auto sm:min-w-0 sm:max-w-xs sm:flex-1">
          <FieldLabel>下載檔名</FieldLabel>
          <div className="flex items-center gap-1">
            <input className={INPUT_CLASS} value={outputName} placeholder={defaultName} onChange={(e) => setOutputName(e.target.value)} />
            <span className="text-sm text-slate-500">.pdf</span>
          </div>
        </div>
        <Button disabled={busy || pages.length === 0} onClick={() => runExport('downloadAll', planAllPages(pages, name))}>
          {sourceCount > 1 ? `合併下載 PDF（${pages.length} 頁）` : `下載 PDF（${pages.length} 頁）`}
        </Button>
        <Button variant="secondary" disabled={busy || selectedCount === 0} onClick={() => runExport('downloadSelected', planSelectedPages(pages, selectedIds, name))}>
          只下載勾選的頁{selectedCount > 0 ? `（${selectedCount} 頁）` : ''}
        </Button>
        {sourceCount > 1 && (
          <Button variant="secondary" disabled={busy} onClick={() => runExport('perSource', planPerSource(pages, sourceNames, name))}>
            各檔分開下載
          </Button>
        )}
      </div>

      <details className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <summary className="cursor-pointer font-medium">✂️ 拆分成多個檔案</summary>
        <fieldset className="mt-3 space-y-2">
          <legend className="sr-only">拆分方式</legend>
          <label className="flex flex-wrap items-center gap-2">
            <input type="radio" name="wsSplitMode" checked={splitMode === 'ranges'} onChange={() => setSplitMode('ranges')} />
            依頁碼範圍（每個範圍一個檔）
            <input
              className={`${INPUT_CLASS} min-w-[12rem] flex-1`}
              placeholder="例如 1-3, 5, 8-（8- 表示第 8 頁到最後）"
              value={rangeText}
              onChange={(e) => {
                setRangeText(e.target.value);
                setSplitMode('ranges');
              }}
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="wsSplitMode" checked={splitMode === 'every'} onChange={() => setSplitMode('every')} />
            每
            <span className="w-20 shrink-0">
              <input
                type="number"
                min={1}
                className={INPUT_CLASS}
                value={everyN}
                onChange={(e) => {
                  setEveryN(e.target.value);
                  setSplitMode('every');
                }}
              />
            </span>
            頁一個檔
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="wsSplitMode" checked={splitMode === 'single'} onChange={() => setSplitMode('single')} />
            每一頁各存成一個檔
          </label>
          <p className={`text-xs ${split.ok ? 'text-slate-500' : 'text-red-600'}`}>
            {split.ok ? `${describeSplitGroups(split.groups)}（頁碼是上面清單的順序，多個檔案會打包成 ZIP）` : split.error}
          </p>
          <Button variant="secondary" disabled={busy || !split.ok} onClick={() => split.ok && runExport('split', planSplit(pages, split.groups, name))}>
            拆分下載
          </Button>
        </fieldset>
      </details>
      <StatusLine status={status} />
    </div>
  );
}
