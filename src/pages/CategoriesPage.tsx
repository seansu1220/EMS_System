/**
 * 屬性管理頁。
 * 可新增、改名、拖曳排序、刪除屬性。
 * 排序改為拖曳（桌機滑鼠、手機長按），放開後依新順序批次寫入 sortOrder（0..n-1）。
 * 刪除仍被業務使用的屬性前，須先選擇轉移目標屬性，批次轉移後再刪除。
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
import { useAuth } from '../hooks/useAuth';
import { useCategories } from '../hooks/useCategories';
import {
  countTasksInCategory,
  createCategory,
  deleteCategory,
  reassignTasksCategory,
  renameCategory,
  reorderCategories,
} from '../services/categoryService';
import type { Category } from '../types/category';
import { Button, Card, CenteredSpinner, ErrorBanner, INPUT_CLASS } from '../components/ui';

/** 進行中刪除流程的狀態：需要轉移時記錄目標屬性與使用數。 */
interface DeleteFlow {
  category: Category;
  taskCount: number;
  targetId: string;
}

export function CategoriesPage() {
  const { user } = useAuth();
  const { categories, loading, error: loadError } = useCategories();

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deleteFlow, setDeleteFlow] = useState<DeleteFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 本地排序 state：拖曳時樂觀更新，避免等待 Firestore 回波。
  const [orderedCategories, setOrderedCategories] = useState<Category[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);

  // 非拖曳且非儲存中時，才與即時訂閱資料同步，避免寫入回波把畫面閃回舊順序。
  useEffect(() => {
    if (isDragging || savingOrder) return;
    setOrderedCategories(categories);
  }, [categories, isDragging, savingOrder]);

  // 感測器：滑鼠移動 5px 才啟動；觸控需長按 200ms（避免與捲動衝突）。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  async function handleAdd() {
    if (!user) return;
    const name = newName.trim();
    if (!name) {
      setError('請輸入屬性名稱。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextSortOrder = categories.length
        ? Math.max(...categories.map((category) => category.sortOrder)) + 1
        : 0;
      await createCategory(name, nextSortOrder, user.uid);
      setNewName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(category: Category) {
    const name = editingName.trim();
    if (!name) {
      setError('屬性名稱不可為空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameCategory(category.id, name);
      setEditingId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 拖曳結束：算出新順序 → 樂觀更新本地 state → 批次寫入 sortOrder。 */
  async function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = orderedCategories.findIndex((item) => item.id === active.id);
    const newIndex = orderedCategories.findIndex((item) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(orderedCategories, oldIndex, newIndex);
    setOrderedCategories(reordered); // 樂觀更新，畫面立即反映新順序
    setSavingOrder(true);
    setError(null);
    try {
      await reorderCategories(reordered.map((item) => item.id));
    } catch (err) {
      setError((err as Error).message);
      setOrderedCategories(categories); // 失敗還原為訂閱資料的順序
    } finally {
      setSavingOrder(false);
    }
  }

  /** 點擊刪除：先查使用數。無業務使用則直接確認刪除，否則進入轉移流程。 */
  async function handleDeleteClick(category: Category) {
    if (!user) return;
    setError(null);
    try {
      const count = await countTasksInCategory(category.id, user.uid);
      if (count === 0) {
        if (!window.confirm(`確定刪除屬性「${category.name}」？`)) return;
        await deleteCategory(category.id);
        return;
      }
      // 有業務使用：預設轉移目標為第一個其他屬性。
      const firstOther = categories.find((item) => item.id !== category.id);
      if (!firstOther) {
        setError('沒有其他屬性可轉移，請先新增一個屬性再刪除。');
        return;
      }
      setDeleteFlow({ category, taskCount: count, targetId: firstOther.id });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** 確認轉移並刪除。 */
  async function handleConfirmTransfer() {
    if (!user || !deleteFlow) return;
    setBusy(true);
    setError(null);
    try {
      await reassignTasksCategory(deleteFlow.category.id, deleteFlow.targetId, user.uid);
      await deleteCategory(deleteFlow.category.id);
      setDeleteFlow(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-bold text-slate-800">屬性管理</h1>
      <ErrorBanner message={error ?? loadError} />

      {/* 新增屬性 */}
      <Card>
        <h2 className="mb-3 text-base font-bold text-slate-700">新增屬性</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="輸入屬性名稱"
            className={`${INPUT_CLASS} flex-1`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
          />
          <Button onClick={handleAdd} disabled={busy}>
            新增
          </Button>
        </div>
      </Card>

      {/* 屬性清單（拖曳排序） */}
      <Card>
        <h2 className="mb-1 text-base font-bold text-slate-700">現有屬性</h2>
        <p className="mb-3 text-xs text-slate-400">拖曳左側把手可調整順序（手機請長按把手）。</p>
        {loading ? (
          <CenteredSpinner />
        ) : orderedCategories.length === 0 ? (
          <p className="text-sm text-slate-400">尚無屬性。</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => setIsDragging(true)}
            onDragCancel={() => setIsDragging(false)}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedCategories.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y divide-slate-100">
                {orderedCategories.map((category) => (
                  <SortableCategoryRow
                    key={category.id}
                    category={category}
                    isEditing={editingId === category.id}
                    editingName={editingName}
                    busy={busy}
                    onEditingNameChange={setEditingName}
                    onStartEdit={() => {
                      setEditingId(category.id);
                      setEditingName(category.name);
                    }}
                    onCancelEdit={() => setEditingId(null)}
                    onRename={() => handleRename(category)}
                    onDelete={() => handleDeleteClick(category)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </Card>

      {/* 刪除前轉移業務對話框 */}
      {deleteFlow && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <Card className="w-full max-w-sm">
            <h3 className="mb-2 text-base font-bold text-slate-800">刪除屬性</h3>
            <p className="mb-3 text-sm text-slate-600">
              屬性「{deleteFlow.category.name}」仍有 {deleteFlow.taskCount} 筆業務使用。
              請選擇要將這些業務轉移到哪個屬性，轉移後才會刪除此屬性。
            </p>
            <select
              value={deleteFlow.targetId}
              onChange={(e) =>
                setDeleteFlow((prev) => (prev ? { ...prev, targetId: e.target.value } : prev))
              }
              className={`${INPUT_CLASS} mb-4`}
            >
              {categories
                .filter((item) => item.id !== deleteFlow.category.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDeleteFlow(null)} disabled={busy}>
                取消
              </Button>
              <Button variant="danger" onClick={handleConfirmTransfer} disabled={busy}>
                {busy ? '處理中…' : '轉移並刪除'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/** 單列屬性（可拖曳）。顯示模式含拖曳把手；編輯模式顯示輸入框與儲存/取消。 */
function SortableCategoryRow({
  category,
  isEditing,
  editingName,
  busy,
  onEditingNameChange,
  onStartEdit,
  onCancelEdit,
  onRename,
  onDelete,
}: {
  category: Category;
  isEditing: boolean;
  editingName: string;
  busy: boolean;
  onEditingNameChange: (name: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: category.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 bg-white py-1"
    >
      {isEditing ? (
        <>
          <input
            type="text"
            value={editingName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            className={`${INPUT_CLASS} flex-1`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRename();
            }}
          />
          <Button onClick={onRename} disabled={busy}>
            儲存
          </Button>
          <Button variant="secondary" onClick={onCancelEdit} disabled={busy}>
            取消
          </Button>
        </>
      ) : (
        <>
          {/* 拖曳把手：觸控目標至少 40px、touch-action:none 避免與捲動衝突。 */}
          <button
            type="button"
            aria-label="拖曳排序"
            title="拖曳排序"
            {...attributes}
            {...listeners}
            className="flex h-10 w-10 flex-shrink-0 touch-none cursor-grab items-center justify-center rounded-lg text-lg text-slate-400 select-none hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
          >
            ⠿
          </button>
          <span className="flex-1 font-medium text-slate-800">{category.name}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onStartEdit}
              className="rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
            >
              改名
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50"
            >
              刪除
            </button>
          </div>
        </>
      )}
    </li>
  );
}
