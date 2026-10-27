/**
 * PDF 工具：合併。多個 PDF 與 JPG／PNG 依清單順序合成一份 PDF。
 * 清單可拖曳（手機長按）或用 ↑↓ 調整順序。
 */
import { useState } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MERGE_ACCEPT } from '../../config/pdfTools';
import { downloadBlob, loadPdfDocument, mergeItems, pdfBlob, readFileBytes } from '../../lib/pdfEngine';
import { detectFileKind, formatBytes, moveItem, safeFilename } from '../../lib/pdfPageLogic';
import type { ImagePageMode, MergeItem } from '../../types/pdfTools';
import { Button, FieldLabel, INPUT_CLASS } from '../ui';
import { PdfDropzone, RowIconButton, StatusLine, type StatusMessage } from './PdfToolParts';

/** 讀取選到的檔案；不支援或讀不了的另外列出原因。 */
async function readMergeFiles(files: File[], idPrefix: string) {
  const added: MergeItem[] = [];
  const skipped: string[] = [];
  for (const [index, file] of files.entries()) {
    const kind = detectFileKind(file);
    if (!kind) {
      skipped.push(`${file.name}（格式不支援）`);
      continue;
    }
    try {
      const bytes = await readFileBytes(file);
      const pageCount = kind === 'pdf' ? (await loadPdfDocument(bytes, file.name)).getPageCount() : 1;
      added.push({ id: `${idPrefix}-${index}`, file, kind, bytes, pageCount });
    } catch (error) {
      skipped.push((error as Error).message);
    }
  }
  return { added, skipped };
}

export function PdfMergePanel() {
  const [items, setItems] = useState<MergeItem[]>([]);
  const [outputName, setOutputName] = useState('合併後的檔案');
  const [imageMode, setImageMode] = useState<ImagePageMode>('a4');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  async function handleFiles(files: File[]) {
    setStatus({ text: '讀取檔案中…', tone: 'info' });
    const { added, skipped } = await readMergeFiles(files, String(Date.now()));
    const next = [...items, ...added];
    setItems(next);
    const totalPages = next.reduce((sum, item) => sum + item.pageCount, 0);
    setStatus(
      skipped.length
        ? { text: `⚠ 以下檔案未加入：${skipped.join('；')}`, tone: 'error' }
        : { text: `已加入 ${next.length} 個檔案，合併後共 ${totalPages} 頁`, tone: 'ok' },
    );
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from !== -1 && to !== -1) setItems(moveItem(items, from, to));
  }

  async function handleMerge() {
    setBusy(true);
    setStatus({ text: '合併中，請稍候…', tone: 'info' });
    try {
      const bytes = await mergeItems(items, imageMode);
      const filename = `${safeFilename(outputName)}.pdf`;
      downloadBlob(pdfBlob(bytes), filename);
      setStatus({ text: `✔ 已下載「${filename}」（${formatBytes(bytes.length)}）`, tone: 'ok' });
    } catch (error) {
      console.error('合併失敗（PdfMergePanel handleMerge）：', error);
      setStatus({ text: `✘ 合併失敗：${(error as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const hasImage = items.some((item) => item.kind !== 'pdf');
  return (
    <div className="space-y-4">
      <PdfDropzone
        accept={MERGE_ACCEPT}
        multiple
        icon="📂"
        title="點這裡選擇檔案，或把檔案拖曳進來"
        hint="支援 PDF、JPG、PNG，可一次選多個"
        onFiles={handleFiles}
      />

      {items.length > 0 && (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2" aria-label="要合併的檔案（依順序）">
                {items.map((item, index) => (
                  <SortableMergeRow
                    key={item.id}
                    item={item}
                    index={index}
                    isLast={index === items.length - 1}
                    onMove={(to) => setItems(moveItem(items, index, to))}
                    onRemove={() => setItems(items.filter((other) => other.id !== item.id))}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel>輸出檔名</FieldLabel>
              <div className="flex items-center gap-1">
                <input className={INPUT_CLASS} value={outputName} onChange={(e) => setOutputName(e.target.value)} />
                <span className="text-sm text-slate-500">.pdf</span>
              </div>
            </div>
            {hasImage && (
              <div>
                <FieldLabel>圖片頁面大小</FieldLabel>
                <select className={INPUT_CLASS} value={imageMode} onChange={(e) => setImageMode(e.target.value as ImagePageMode)}>
                  <option value="a4">放進 A4 頁面（適合列印）</option>
                  <option value="original">依圖片原始尺寸</option>
                </select>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleMerge} disabled={busy}>{busy ? '合併中…' : '合併並下載'}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => { setItems([]); setStatus(null); }}>
              全部清除
            </Button>
          </div>
        </>
      )}

      <StatusLine status={status} />
      <p className="text-xs text-slate-500">
        小技巧：用 ↑ ↓ 按鈕或拖曳左側 ⠿ 調整順序（手機請長按再拖），合併時依清單由上到下排列。
      </p>
    </div>
  );
}

function SortableMergeRow({
  item,
  index,
  isLast,
  onMove,
  onRemove,
}: {
  item: MergeItem;
  index: number;
  isLast: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const kindLabel = item.kind === 'pdf' ? `${item.pageCount} 頁` : '圖片';

  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <button
        type="button"
        className="cursor-grab touch-none px-1 text-lg text-slate-400 active:cursor-grabbing"
        title="拖曳調整順序"
        aria-label="拖曳調整順序"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="w-6 text-center text-sm font-bold text-slate-500">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-800">{item.file.name}</div>
        <div className="text-xs text-slate-500">{kindLabel}・{formatBytes(item.file.size)}</div>
      </div>
      <RowIconButton title="上移" disabled={index === 0} onClick={() => onMove(index - 1)}>↑</RowIconButton>
      <RowIconButton title="下移" disabled={isLast} onClick={() => onMove(index + 1)}>↓</RowIconButton>
      <RowIconButton title="移除" danger onClick={onRemove}>✕</RowIconButton>
    </li>
  );
}
