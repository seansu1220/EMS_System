/**
 * PDF 工具：拆分。依頁碼範圍／每 N 頁／每頁拆成多份，或擷取指定頁面合成一份。
 * 點縮圖可選頁，選取結果自動回填頁碼欄；產生多個檔案時打包成 ZIP。
 */
import { useMemo, useState } from 'react';
import { PDF_ACCEPT, PDF_TOOLS_CONFIG } from '../../config/pdfTools';
import { useSinglePdf } from '../../hooks/useSinglePdf';
import { buildSplitFiles, downloadBlob, packageSplitFiles } from '../../lib/pdfEngine';
import {
  RANGE_SPLIT_MODES,
  buildSplitGroups,
  compressRanges,
  describeSplitGroups,
  formatBytes,
} from '../../lib/pdfPageLogic';
import type { PageGroupsResult, SplitMode } from '../../types/pdfTools';
import { Button, INPUT_CLASS } from '../ui';
import { PdfDropzone, PdfThumbnail, StatusLine, type StatusMessage } from './PdfToolParts';

const SPLIT_MODE_LABELS: Record<SplitMode, string> = {
  ranges: '依頁碼範圍拆分（每個範圍一個檔案）',
  extract: '擷取頁面（選到的頁面合成一個檔案）',
  every: '每 N 頁一個檔案',
  single: '每一頁各存成一個檔案',
};

export function PdfSplitPanel() {
  const { source, open } = useSinglePdf();
  const [mode, setMode] = useState<SplitMode>('ranges');
  const [rangeText, setRangeText] = useState('');
  const [everyN, setEveryN] = useState('2');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const needsRange = RANGE_SPLIT_MODES.includes(mode);
  const result: PageGroupsResult | null = useMemo(() => {
    if (!source || (needsRange && rangeText.trim() === '')) return null;
    return buildSplitGroups(mode, rangeText, everyN, source.pageCount);
  }, [source, mode, rangeText, everyN, needsRange]);

  // 頁碼欄解析得出來時，縮圖跟著標示選取；解析失敗時維持空白，不亂標。
  const selected = useMemo(
    () => new Set(needsRange && result?.ok ? result.groups.flat() : []),
    [needsRange, result],
  );

  async function handleFiles(files: File[]) {
    setStatus({ text: '讀取中…', tone: 'info' });
    try {
      const loaded = await open(files);
      setRangeText('');
      const large = loaded.file.size > PDF_TOOLS_CONFIG.largeFileWarnBytes;
      setStatus(large ? { text: '⚠ 檔案較大，處理可能需要一些時間', tone: 'info' } : null);
    } catch (error) {
      setStatus({ text: `✘ ${(error as Error).message}`, tone: 'error' });
    }
  }

  function togglePage(page: number) {
    const next = new Set(selected);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    if (!needsRange) setMode('extract');
    setRangeText(compressRanges(next));
  }

  async function handleSplit() {
    if (!source || !result?.ok) return;
    setBusy(true);
    setStatus({ text: '處理中，請稍候…', tone: 'info' });
    try {
      const files = await buildSplitFiles(source.bytes, source.file.name, result.groups, mode);
      const { blob, filename } = await packageSplitFiles(files, source.file.name);
      downloadBlob(blob, filename);
      setStatus({ text: `✔ 已下載「${filename}」`, tone: 'ok' });
    } catch (error) {
      console.error('拆分失敗（PdfSplitPanel handleSplit）：', error);
      setStatus({ text: `✘ 拆分失敗：${(error as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const preview: StatusMessage | null = !source
    ? null
    : !result
      ? { text: '請輸入頁碼，或直接點下方縮圖選取頁面', tone: 'info' }
      : result.ok
        ? { text: describeSplitGroups(mode, result.groups), tone: 'info' }
        : { text: result.error, tone: 'error' };

  return (
    <div className="space-y-4">
      <PdfDropzone
        accept={PDF_ACCEPT}
        compact={!!source}
        icon="📄"
        title={source ? '換一份 PDF' : '點這裡選擇 PDF，或把檔案拖曳進來'}
        hint="一次處理一份 PDF"
        onFiles={handleFiles}
      />

      {source && (
        <>
          <p className="text-sm text-slate-600">
            <strong className="text-slate-800">{source.file.name}</strong>　共 {source.pageCount} 頁・{formatBytes(source.file.size)}
          </p>

          <fieldset className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <legend className="sr-only">拆分方式</legend>
            {(['ranges', 'extract'] as const).map((value) => (
              <ModeRadio key={value} value={value} current={mode} onChange={setMode} />
            ))}
            <label className="flex flex-wrap items-center gap-2 pl-6">
              頁碼
              <input
                className={`${INPUT_CLASS} flex-1`}
                placeholder="例如 1-3, 5, 8-（8- 表示第 8 頁到最後）"
                value={rangeText}
                onChange={(e) => {
                  setRangeText(e.target.value);
                  if (!needsRange) setMode('ranges');
                }}
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="splitMode" checked={mode === 'every'} onChange={() => setMode('every')} />
              每
              <span className="w-20 shrink-0">
                <input
                  type="number"
                  min={1}
                  className={INPUT_CLASS}
                  value={everyN}
                  onChange={(e) => {
                    setEveryN(e.target.value);
                    setMode('every');
                  }}
                />
              </span>
              頁一個檔案
            </label>
            <ModeRadio value="single" current={mode} onChange={setMode} />
          </fieldset>

          <StatusLine status={preview} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSplit} disabled={busy || !result?.ok}>{busy ? '處理中…' : '拆分並下載'}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => setRangeText('')}>清除選取</Button>
          </div>
          <StatusLine status={status} />

          <p className="text-xs text-slate-500">點縮圖可選取頁面，選取結果會自動填入上方頁碼。產生多個檔案時會打包成 ZIP 下載。</p>
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: source.pageCount }, (_, i) => i + 1).map((page) => (
              <button
                key={`${source.file.name}-${page}`}
                type="button"
                onClick={() => togglePage(page)}
                aria-pressed={selected.has(page)}
                className={`relative rounded-lg border-2 bg-white p-1.5 text-center transition-colors ${
                  selected.has(page) ? 'border-slate-700 bg-slate-100' : 'border-slate-200 hover:border-slate-400'
                }`}
              >
                {selected.has(page) && (
                  <span className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-xs text-white">
                    ✓
                  </span>
                )}
                <PdfThumbnail pdf={source.preview} pageNumber={page} />
                <div className="mt-1 text-xs text-slate-600">第 {page} 頁</div>
              </button>
            ))}
          </div>
        </>
      )}
      {!source && <StatusLine status={status} />}
    </div>
  );
}

function ModeRadio({
  value,
  current,
  onChange,
}: {
  value: SplitMode;
  current: SplitMode;
  onChange: (mode: SplitMode) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="radio" name="splitMode" checked={current === value} onChange={() => onChange(value)} />
      {SPLIT_MODE_LABELS[value]}
    </label>
  );
}
