/**
 * PDF 工作區的頁面清單：點一頁＝右側滑出大圖預覽；拖曳（手機長按）調整順序。
 * 多選（v1.31）：左上角勾選框、Ctrl＋點選（加選／取消）、Shift＋點選（連選一整段）、在空白處或卡片邊框拉框（見 useMarqueeSelection）。
 * 拖曳一張已勾選的頁時，所有勾選的頁一起搬過去（保持彼此的先後）。
 * 每頁下方的色點標示是哪個檔案的頁。電腦寬度時排成多欄、直式捲動（預覽打開時欄數自動變少），手機寬度時橫向捲動。
 */
import { useRef, useState, type MouseEvent } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PDF_WORKSPACE_CONFIG } from '../../config/pdfTools';
import type { WorkPage, WorkSource } from '../../types/pdfTools';
import { PdfThumbnail } from './PdfToolParts';
import { useMarqueeSelection } from './useMarqueeSelection';

/** 拖曳這一頁時要一起搬的頁：它是勾選的其中一頁就搬全部勾選的（依清單順序），否則只搬它。 */
function dragGroupOf(pageId: string, pages: readonly WorkPage[], selectedIds: readonly string[]): string[] {
  if (!selectedIds.includes(pageId) || selectedIds.length < 2) return [pageId];
  return pages.filter((page) => selectedIds.includes(page.id)).map((page) => page.id);
}

export function WorkspacePageList({
  pages,
  sources,
  currentPageId,
  selectedIds,
  onShowPage,
  onToggleSelect,
  onSelectRange,
  onSetSelection,
  onMoveBlock,
}: {
  pages: readonly WorkPage[];
  sources: ReadonlyMap<string, WorkSource>;
  currentPageId: string | null;
  selectedIds: readonly string[];
  onShowPage: (pageId: string) => void;
  onToggleSelect: (pageId: string) => void;
  onSelectRange: (fromId: string, toId: string, additive: boolean) => void;
  onSetSelection: (pageIds: string[]) => void;
  onMoveBlock: (pageIds: string[], anchorId: string, placeAfter: boolean) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const [dragGroup, setDragGroup] = useState<{ activeId: string; pageIds: string[] } | null>(null);
  /** Shift＋點選的起點：上一次點選或勾選的頁。 */
  const rangeAnchor = useRef<string | null>(null);
  const { box, marqueeHandlers } = useMarqueeSelection({
    selectedIds,
    onSelect: onSetSelection,
    onClear: () => onSetSelection([]),
  });

  function handleDragStart({ active }: DragStartEvent) {
    const activeId = String(active.id);
    setDragGroup({ activeId, pageIds: dragGroupOf(activeId, pages, selectedIds) });
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    const group = dragGroup?.pageIds ?? [String(active.id)];
    setDragGroup(null);
    if (!over || group.includes(String(over.id))) return;
    const from = pages.findIndex((page) => page.id === active.id);
    const to = pages.findIndex((page) => page.id === over.id);
    if (from !== -1 && to !== -1) onMoveBlock(group, String(over.id), to > from);
  }

  function handleCardClick(pageId: string, event: MouseEvent) {
    if (event.shiftKey) {
      onSelectRange(rangeAnchor.current ?? currentPageId ?? pageId, pageId, event.ctrlKey || event.metaKey);
      return;
    }
    rangeAnchor.current = pageId;
    if (event.ctrlKey || event.metaKey) onToggleSelect(pageId);
    else onShowPage(pageId);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDragGroup(null)}>
      <SortableContext items={pages.map((page) => page.id)} strategy={rectSortingStrategy}>
        <div
          data-ws="page-list"
          aria-label="頁面清單（依輸出順序）"
          className="relative flex shrink-0 select-none gap-2 overflow-x-auto pb-2 md:grid md:max-h-[calc(100vh-140px)] md:min-w-0 md:flex-1 md:shrink md:grid-cols-[repeat(auto-fill,124px)] md:content-start md:overflow-x-hidden md:overflow-y-auto md:pb-8"
          {...marqueeHandlers}
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
                carriedAlong={!!dragGroup && dragGroup.activeId !== page.id && dragGroup.pageIds.includes(page.id)}
                groupSize={dragGroup?.activeId === page.id ? dragGroup.pageIds.length : 0}
                onClick={(event) => handleCardClick(page.id, event)}
                onToggle={() => {
                  rangeAnchor.current = page.id;
                  onToggleSelect(page.id);
                }}
              />
            );
          })}
          {box && (
            <div
              data-ws="marquee"
              className="pointer-events-none absolute z-20 rounded border border-sky-500 bg-sky-400/15"
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            />
          )}
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
  carriedAlong,
  groupSize,
  onClick,
  onToggle,
}: {
  page: WorkPage;
  source: WorkSource;
  pageNumber: number;
  current: boolean;
  selected: boolean;
  /** 正在被一起拖走的其他勾選頁（淡化顯示）。 */
  carriedAlong: boolean;
  /** 被拖曳的那張卡片要顯示「一起搬幾頁」；不是被拖的卡片為 0。 */
  groupSize: number;
  onClick: (event: MouseEvent) => void;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : carriedAlong ? 0.3 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const border = current ? 'border-slate-800 ring-2 ring-slate-800/30' : selected ? 'border-sky-500 bg-sky-50' : 'border-slate-200 bg-white';

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-ws="page-card"
      data-page-id={page.id}
      data-selected={selected ? 'true' : 'false'}
      className={`relative shrink-0 rounded-lg border-2 p-1.5 text-center ${border}`}
    >
      <input
        type="checkbox"
        data-ws="page-check"
        checked={selected}
        onChange={onToggle}
        aria-label={`勾選第 ${pageNumber} 頁`}
        className="absolute left-2 top-2 z-10 h-4 w-4 cursor-pointer accent-sky-600"
      />
      {groupSize > 1 && (
        <span className="absolute -right-2 -top-2 z-10 rounded-full bg-sky-600 px-2 py-0.5 text-xs font-bold text-white shadow" data-ws="drag-count">
          {groupSize} 頁
        </span>
      )}
      <button
        type="button"
        className="block cursor-pointer touch-manipulation"
        title="點一下在右側打開大圖；Ctrl＋點選加選、Shift＋點選連選；按住拖曳可調整順序"
        aria-label={`第 ${pageNumber} 頁，看大圖`}
        aria-current={current ? 'page' : undefined}
        onClick={onClick}
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
