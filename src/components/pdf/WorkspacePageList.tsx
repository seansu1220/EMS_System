/**
 * PDF 工作區中間的頁面清單：點一頁＝右邊顯示大圖；左上角勾選框可多選；拖曳（手機長按）調整順序。
 * 每頁下方的色點標示是哪個檔案的頁。電腦寬度時直式捲動，手機寬度時橫向捲動。
 */
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
import { PDF_WORKSPACE_CONFIG } from '../../config/pdfTools';
import type { WorkPage, WorkSource } from '../../types/pdfTools';
import { PdfThumbnail } from './PdfToolParts';

export function WorkspacePageList({
  pages,
  sources,
  currentPageId,
  selectedIds,
  onShowPage,
  onToggleSelect,
  onMove,
}: {
  pages: readonly WorkPage[];
  sources: ReadonlyMap<string, WorkSource>;
  currentPageId: string | null;
  selectedIds: readonly string[];
  onShowPage: (pageId: string) => void;
  onToggleSelect: (pageId: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = pages.findIndex((page) => page.id === active.id);
    const to = pages.findIndex((page) => page.id === over.id);
    if (from !== -1 && to !== -1) onMove(from, to);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={pages.map((page) => page.id)} strategy={rectSortingStrategy}>
        <div
          data-ws="page-list"
          aria-label="頁面清單（依輸出順序）"
          className="flex shrink-0 gap-2 overflow-x-auto pb-2 md:grid md:max-h-[75vh] md:w-[140px] md:grid-cols-1 md:content-start md:overflow-x-hidden md:overflow-y-auto md:pb-0 lg:w-[256px] lg:grid-cols-2"
        >
          {pages.map((page, index) => {
            const source = sources.get(page.sourceId);
            if (!source) return null;
            return (
              <SortablePageCard
                key={page.id}
                page={page}
                source={source}
                pageNumber={index + 1}
                current={page.id === currentPageId}
                selected={selectedIds.includes(page.id)}
                onShow={() => onShowPage(page.id)}
                onToggle={() => onToggleSelect(page.id)}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortablePageCard({
  page,
  source,
  pageNumber,
  current,
  selected,
  onShow,
  onToggle,
}: {
  page: WorkPage;
  source: WorkSource;
  pageNumber: number;
  current: boolean;
  selected: boolean;
  onShow: () => void;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const border = current ? 'border-slate-800 ring-2 ring-slate-800/30' : selected ? 'border-sky-500' : 'border-slate-200';

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-ws="page-card"
      data-page-id={page.id}
      className={`relative shrink-0 rounded-lg border-2 bg-white p-1.5 text-center ${border}`}
    >
      <input
        type="checkbox"
        data-ws="page-check"
        checked={selected}
        onChange={onToggle}
        aria-label={`勾選第 ${pageNumber} 頁`}
        className="absolute left-2 top-2 z-10 h-4 w-4 cursor-pointer accent-sky-600"
      />
      <button
        type="button"
        className="block cursor-pointer touch-manipulation"
        title="點一下看大圖，按住拖曳可調整順序"
        aria-label={`第 ${pageNumber} 頁，看大圖`}
        aria-current={current ? 'page' : undefined}
        onClick={onShow}
        {...attributes}
        {...listeners}
      >
        <PdfThumbnail pdf={source.preview} pageNumber={page.sourcePageIndex + 1} rotation={page.rotation} marks={page.marks} />
      </button>
      <div className="mt-1 flex items-center justify-center gap-1 text-xs text-slate-600">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: PDF_WORKSPACE_CONFIG.sourceColors[source.colorIndex] }}
          title={`${source.name} 第 ${page.sourcePageIndex + 1} 頁`}
        />
        第 {pageNumber} 頁
        {page.marks.length > 0 && <span title="這頁有標記">🖍</span>}
      </div>
    </div>
  );
}
