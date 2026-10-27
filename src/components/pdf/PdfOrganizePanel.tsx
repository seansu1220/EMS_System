/**
 * PDF 工具：頁面整理。縮圖拖曳排序（手機長按）、旋轉、刪除頁面後輸出新檔。
 * 旋轉與刪除只套用在下載的新檔，原始檔案不會被修改。
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
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PDF_ACCEPT } from '../../config/pdfTools';
import { useSinglePdf } from '../../hooks/useSinglePdf';
import { buildOrganizedPdf, downloadBlob, pdfBlob } from '../../lib/pdfEngine';
import {
  baseName,
  formatBytes,
  initialPageOrder,
  moveItem,
  removePageAt,
  rotateAllPages,
  rotatePageAt,
  safeFilename,
} from '../../lib/pdfPageLogic';
import type { PDFDocumentProxy } from '../../lib/pdfRender';
import type { OrganizedPage } from '../../types/pdfTools';
import { Button, FieldLabel, INPUT_CLASS } from '../ui';
import { PdfDropzone, PdfThumbnail, RowIconButton, StatusLine, type StatusMessage } from './PdfToolParts';

/** 拖曳排序用的鍵：同一來源頁只會出現一次，直接用來源索引。 */
const pageKey = (page: OrganizedPage) => `p${page.sourceIndex}`;

type PageAction = 'left' | 'right' | 'ccw' | 'cw' | 'remove';

export function PdfOrganizePanel() {
  const { source, open } = useSinglePdf();
  const [pages, setPages] = useState<OrganizedPage[]>([]);
  const [outputName, setOutputName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  async function handleFiles(files: File[]) {
    setStatus({ text: '讀取中…', tone: 'info' });
    try {
      const loaded = await open(files);
      setPages(initialPageOrder(loaded.pageCount));
      setOutputName(`${baseName(loaded.file.name)}_整理後`);
      setStatus(null);
    } catch (error) {
      setStatus({ text: `✘ ${(error as Error).message}`, tone: 'error' });
    }
  }

  function handlePageAction(index: number, action: PageAction) {
    if (action === 'remove' && pages.length === 1) {
      setStatus({ text: '至少要保留 1 頁', tone: 'error' });
      return;
    }
    if (action === 'left') setPages(moveItem(pages, index, index - 1));
    if (action === 'right') setPages(moveItem(pages, index, index + 1));
    if (action === 'ccw') setPages(rotatePageAt(pages, index, -90));
    if (action === 'cw') setPages(rotatePageAt(pages, index, 90));
    if (action === 'remove') setPages(removePageAt(pages, index));
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = pages.findIndex((page) => pageKey(page) === active.id);
    const to = pages.findIndex((page) => pageKey(page) === over.id);
    if (from !== -1 && to !== -1) setPages(moveItem(pages, from, to));
  }

  async function handleSave() {
    if (!source) return;
    setBusy(true);
    setStatus({ text: '處理中，請稍候…', tone: 'info' });
    try {
      const bytes = await buildOrganizedPdf(source.bytes, source.file.name, pages);
      const filename = `${safeFilename(outputName)}.pdf`;
      downloadBlob(pdfBlob(bytes), filename);
      setStatus({ text: `✔ 已下載「${filename}」（${pages.length} 頁，${formatBytes(bytes.length)}）`, tone: 'ok' });
    } catch (error) {
      console.error('輸出失敗（PdfOrganizePanel handleSave）：', error);
      setStatus({ text: `✘ 輸出失敗：${(error as Error).message}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const removedCount = source ? source.pageCount - pages.length : 0;
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
            <strong className="text-slate-800">{source.file.name}</strong>　原本 {source.pageCount} 頁，整理後 {pages.length} 頁
            {removedCount > 0 && `（已刪除 ${removedCount} 頁）`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPages(rotateAllPages(pages, 90))}>全部向右轉 90°</Button>
            <Button variant="secondary" onClick={() => setPages([...pages].reverse())}>反轉順序</Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPages(initialPageOrder(source.pageCount));
                setStatus({ text: '已復原為原始狀態', tone: 'info' });
              }}
            >
              全部復原
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <FieldLabel>輸出檔名</FieldLabel>
              <div className="flex items-center gap-1">
                <input className={INPUT_CLASS} value={outputName} onChange={(e) => setOutputName(e.target.value)} />
                <span className="text-sm text-slate-500">.pdf</span>
              </div>
            </div>
            <Button onClick={handleSave} disabled={busy}>{busy ? '處理中…' : '套用並下載'}</Button>
          </div>
          <StatusLine status={status} />

          <p className="text-xs text-slate-500">
            直接拖曳縮圖調整順序（手機請長按再拖，或用 ← → 按鈕）。旋轉與刪除只會套用在下載的新檔案，原始檔案不會被修改。
          </p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={pages.map(pageKey)} strategy={rectSortingStrategy}>
              <div className="flex flex-wrap gap-3">
                {pages.map((page, index) => (
                  <SortablePageCard
                    key={`${source.file.name}-${pageKey(page)}`}
                    page={page}
                    index={index}
                    isLast={index === pages.length - 1}
                    pdf={source.preview}
                    onAction={(action) => handlePageAction(index, action)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}
      {!source && <StatusLine status={status} />}
    </div>
  );
}

function SortablePageCard({
  page,
  index,
  isLast,
  pdf,
  onAction,
}: {
  page: OrganizedPage;
  index: number;
  isLast: boolean;
  pdf: PDFDocumentProxy;
  onAction: (action: PageAction) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pageKey(page) });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const moved = page.sourceIndex !== index ? `（原第 ${page.sourceIndex + 1} 頁）` : '';

  return (
    <div ref={setNodeRef} style={style} className="rounded-lg border-2 border-slate-200 bg-white p-1.5 text-center">
      <div className="cursor-grab touch-none active:cursor-grabbing" title="拖曳調整順序" {...attributes} {...listeners}>
        <PdfThumbnail pdf={pdf} pageNumber={page.sourceIndex + 1} rotation={page.rotation} />
      </div>
      <div className="mt-1 text-xs text-slate-600">第 {index + 1} 頁{moved}</div>
      <div className="mt-1 flex justify-center gap-0.5">
        <RowIconButton title="往前移" disabled={index === 0} onClick={() => onAction('left')}>←</RowIconButton>
        <RowIconButton title="向左轉 90°" onClick={() => onAction('ccw')}>⟲</RowIconButton>
        <RowIconButton title="向右轉 90°" onClick={() => onAction('cw')}>⟳</RowIconButton>
        <RowIconButton title="往後移" disabled={isLast} onClick={() => onAction('right')}>→</RowIconButton>
        <RowIconButton title="刪除此頁" danger onClick={() => onAction('remove')}>✕</RowIconButton>
      </div>
    </div>
  );
}
