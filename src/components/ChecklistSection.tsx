/**
 * 業務待辦事項（checklist）區塊。
 * 可新增（內容 + 可選期限）、編輯（內容/期限）、勾選完成、刪除、拖曳調整流程順序，
 * 並可套用 / 另存待辦公版（見 ChecklistTemplateBar）。
 * 排序有兩種模式（見 lib/checklistLogic）：
 * - 流程順序：依 sortOrder（標案等多流程業務用，可拖曳調整）。
 * - 依期限：未勾在前、期限近到遠、無期限最後。
 * 逾期且未勾以紅色、剩餘工作日在 urgent 天數內以橙色標示期限（與首頁提醒卡同一套算法）。
 * 純 UI + 事件捕捉；資料存取委由 taskService（更新 task 文件的 checklistItems 陣列）。
 */
import { useEffect, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  addChecklistItem,
  completeChecklistItemWithProgress,
  removeChecklistItem,
  reorderChecklistItems,
  toggleChecklistItem,
  updateChecklistItem,
} from '../services/taskService';
import type { ChecklistItem, Task } from '../types/task';
import { useHolidays } from '../hooks/useHolidays';
import { nowTime, today } from '../lib/taskLogic';
import type { WorkdayCalendar } from '../lib/workday';
import {
  CHECKLIST_SORT_MODES,
  checklistDeadlineToneClass,
  checklistProgress,
  sortChecklistItems,
  type ChecklistSortMode,
} from '../lib/checklistLogic';
import { ChecklistTemplateBar } from './ChecklistTemplateBar';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

interface ChecklistSectionProps {
  task: Task;
  /** 是否鎖定（業務已完成，不可新增/編輯/勾選/刪除）。 */
  locked?: boolean;
}

export function ChecklistSection({ task, locked = false }: ChecklistSectionProps) {
  // 假日清單讀取失敗不阻擋畫面：仍以內建清單判斷期限色調，故此處不取 error。
  const { workdayCalendar } = useHolidays();
  const [content, setContent] = useState('');
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [sortMode, setSortMode] = useState<ChecklistSortMode>('custom');

  // 行內編輯狀態（一次只編輯一筆）。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingDeadline, setEditingDeadline] = useState('');

  // 本地流程順序 state：拖曳時樂觀更新，避免等待 Firestore 回波把畫面閃回舊順序。
  const [orderedItems, setOrderedItems] = useState<ChecklistItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);

  useEffect(() => {
    if (isDragging || savingOrder) return;
    setOrderedItems(sortChecklistItems(task.checklistItems, 'custom'));
  }, [task.checklistItems, isDragging, savingOrder]);

  // 感測器：滑鼠移動 5px 才啟動；觸控需長按 200ms（避免與捲動衝突）。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const sorted =
    sortMode === 'custom' ? orderedItems : sortChecklistItems(task.checklistItems, 'deadline');
  const progress = checklistProgress(task.checklistItems);
  // 已勾項目預設隱藏；展開時才連同已勾一起顯示。
  const visible = showDone ? sorted : sorted.filter((item) => !item.done);
  // 僅「流程順序」模式且未鎖定、未在編輯中時可拖曳。
  const canDrag = sortMode === 'custom' && !locked && editingId === null;

  async function handleAdd() {
    if (!content.trim()) {
      setError('請填寫待辦內容。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addChecklistItem(task, { content: content.trim(), deadline: deadline || null });
      setContent('');
      setDeadline('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(item: ChecklistItem) {
    setError(null);
    try {
      // 取消勾選（true→false）：直接切換，不跳對話框。
      if (item.done) {
        await toggleChecklistItem(task, item.id);
        return;
      }
      // 勾選完成（false→true）：詢問是否一併寫入進度紀錄。
      if (window.confirm(`是否將「${item.content}」寫入進度紀錄？`)) {
        await completeChecklistItemWithProgress(task, item.id, today(), nowTime());
      } else {
        await toggleChecklistItem(task, item.id);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRemove(itemId: string) {
    if (!window.confirm('確定刪除這筆待辦事項？')) return;
    setError(null);
    try {
      await removeChecklistItem(task, itemId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** 開始編輯某筆待辦：把現值帶入行內輸入框。 */
  function handleStartEdit(item: ChecklistItem) {
    setEditingId(item.id);
    setEditingContent(item.content);
    setEditingDeadline(item.deadline ?? '');
    setError(null);
  }

  /** 儲存編輯：內容不可為空；期限留空代表清除期限。 */
  async function handleSaveEdit(itemId: string) {
    const trimmed = editingContent.trim();
    if (!trimmed) {
      setError('待辦內容不可為空。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateChecklistItem(task, itemId, {
        content: trimmed,
        deadline: editingDeadline || null,
      });
      setEditingId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** 拖曳結束：算出新流程順序 → 樂觀更新本地 state → 寫入 sortOrder（0..n-1）。 */
  async function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = orderedItems.findIndex((item) => item.id === active.id);
    const newIndex = orderedItems.findIndex((item) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(orderedItems, oldIndex, newIndex);
    setOrderedItems(reordered); // 樂觀更新，畫面立即反映新順序
    setSavingOrder(true);
    setError(null);
    try {
      await reorderChecklistItems(task, reordered.map((item) => item.id));
    } catch (err) {
      setError((err as Error).message);
      setOrderedItems(sortChecklistItems(task.checklistItems, 'custom')); // 失敗還原
    } finally {
      setSavingOrder(false);
    }
  }

  return (
    <div className="space-y-4">
      {!locked && <ChecklistTemplateBar task={task} />}

      {progress.total > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
            <span>完成進度</span>
            <span>
              {progress.done} / {progress.total}（{progress.percent}%）
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-green-500 transition-all"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {!locked && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <FieldLabel>待辦內容</FieldLabel>
            <input
              type="text"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="例如：確認規格 / 上網公告 / 開標 / 決標…"
              className={INPUT_CLASS}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
            />
          </div>
          <div className="sm:w-44">
            <FieldLabel optional>期限</FieldLabel>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          <Button onClick={handleAdd} disabled={saving}>
            {saving ? '處理中…' : '加入清單'}
          </Button>
        </div>
      )}

      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>排序：</span>
          {CHECKLIST_SORT_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => setSortMode(mode.value)}
              className={`rounded-full px-3 py-1 transition-colors ${
                sortMode === mode.value
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {mode.label}
            </button>
          ))}
          {canDrag && <span className="text-slate-400">（拖曳左側把手可調整流程順序）</span>}
        </div>
      )}

      <ErrorBanner message={error} />

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-400">尚無待辦事項。</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-slate-400">未完成待辦皆已勾除。</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setIsDragging(true)}
          onDragCancel={() => setIsDragging(false)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={visible.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {visible.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  workdayCalendar={workdayCalendar}
                  locked={locked}
                  canDrag={canDrag}
                  busy={saving}
                  isEditing={editingId === item.id}
                  editingContent={editingContent}
                  editingDeadline={editingDeadline}
                  onEditingContentChange={setEditingContent}
                  onEditingDeadlineChange={setEditingDeadline}
                  onStartEdit={() => handleStartEdit(item)}
                  onCancelEdit={() => setEditingId(null)}
                  onSaveEdit={() => handleSaveEdit(item.id)}
                  onToggle={() => handleToggle(item)}
                  onRemove={() => handleRemove(item.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {progress.done > 0 && (
        <button
          type="button"
          onClick={() => setShowDone((prev) => !prev)}
          className="text-xs text-slate-500 hover:underline"
        >
          {showDone ? '隱藏已完成' : `顯示已完成（${progress.done}）`}
        </button>
      )}
    </div>
  );
}

interface ChecklistRowProps {
  item: ChecklistItem;
  /** 假日索引（由 useHolidays 提供），決定期限色調用的剩餘工作日怎麼扣。 */
  workdayCalendar: WorkdayCalendar;
  locked: boolean;
  canDrag: boolean;
  busy: boolean;
  isEditing: boolean;
  editingContent: string;
  editingDeadline: string;
  onEditingContentChange: (value: string) => void;
  onEditingDeadlineChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}

/** 單列待辦（可拖曳）。顯示模式含勾選/內容/期限/編輯/刪除；編輯模式顯示內容與期限輸入框。 */
function ChecklistRow({
  item,
  workdayCalendar,
  locked,
  canDrag,
  busy,
  isEditing,
  editingContent,
  editingDeadline,
  onEditingContentChange,
  onEditingDeadlineChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggle,
  onRemove,
}: ChecklistRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canDrag,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  if (isEditing) {
    return (
      <li ref={setNodeRef} style={style} className="flex flex-col gap-2 bg-white px-4 py-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={editingContent}
          onChange={(e) => onEditingContentChange(e.target.value)}
          className={`${INPUT_CLASS} sm:flex-1`}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSaveEdit();
          }}
        />
        <input
          type="date"
          value={editingDeadline}
          onChange={(e) => onEditingDeadlineChange(e.target.value)}
          className={`${INPUT_CLASS} sm:w-44`}
        />
        <div className="flex gap-1">
          <Button type="button" className="px-3 py-1.5 text-xs" onClick={onSaveEdit} disabled={busy}>
            {busy ? '儲存中…' : '儲存'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-3 py-1.5 text-xs"
            onClick={onCancelEdit}
            disabled={busy}
          >
            取消
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-2 bg-white px-2 py-2 sm:px-4">
      {canDrag && (
        // 拖曳把手：觸控目標 40px、touch-action:none 避免與捲動衝突。
        <button
          type="button"
          aria-label="拖曳調整流程順序"
          title="拖曳調整流程順序"
          {...attributes}
          {...listeners}
          className="flex h-10 w-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-lg text-lg text-slate-400 select-none hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
        >
          ⠿
        </button>
      )}
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0"
        checked={item.done}
        disabled={locked}
        onChange={onToggle}
      />
      <span
        className={`flex-1 whitespace-pre-wrap text-sm ${
          item.done ? 'text-slate-400 line-through' : 'text-slate-700'
        }`}
      >
        {item.content}
      </span>
      {item.deadline ? (
        <span
          className={`shrink-0 font-mono text-xs ${
            item.done
              ? 'text-slate-400 line-through'
              : checklistDeadlineToneClass(item.deadline, workdayCalendar)
          }`}
        >
          {item.deadline}
        </span>
      ) : (
        !item.done && <span className="shrink-0 text-xs text-slate-300">未定期限</span>
      )}
      {!locked && (
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={onStartEdit} className="text-xs text-slate-500 hover:underline">
            編輯
          </button>
          <button onClick={onRemove} className="text-xs text-red-500 hover:underline">
            刪除
          </button>
        </div>
      )}
    </li>
  );
}
