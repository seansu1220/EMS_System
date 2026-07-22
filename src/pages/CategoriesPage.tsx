/**
 * 屬性管理頁。
 * 可新增、改名、上移/下移排序、刪除屬性。
 * 刪除仍被業務使用的屬性前，須先選擇轉移目標屬性，批次轉移後再刪除。
 */
import { useState, type ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useCategories } from '../hooks/useCategories';
import {
  countTasksInCategory,
  createCategory,
  deleteCategory,
  reassignTasksCategory,
  renameCategory,
  swapCategoryOrder,
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

  async function handleMove(index: number, direction: -1 | 1) {
    const neighbor = categories[index + direction];
    const current = categories[index];
    if (!neighbor || !current) return;
    setError(null);
    try {
      await swapCategoryOrder(current, neighbor);
    } catch (err) {
      setError((err as Error).message);
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

      {/* 屬性清單 */}
      <Card>
        <h2 className="mb-3 text-base font-bold text-slate-700">現有屬性</h2>
        {loading ? (
          <CenteredSpinner />
        ) : categories.length === 0 ? (
          <p className="text-sm text-slate-400">尚無屬性。</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {categories.map((category, index) => (
              <li key={category.id} className="flex items-center gap-2 py-3">
                {editingId === category.id ? (
                  <>
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className={`${INPUT_CLASS} flex-1`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(category);
                      }}
                    />
                    <Button onClick={() => handleRename(category)} disabled={busy}>
                      儲存
                    </Button>
                    <Button variant="secondary" onClick={() => setEditingId(null)} disabled={busy}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 font-medium text-slate-800">{category.name}</span>
                    <div className="flex items-center gap-1">
                      <IconButton
                        label="上移"
                        disabled={index === 0}
                        onClick={() => handleMove(index, -1)}
                      >
                        ↑
                      </IconButton>
                      <IconButton
                        label="下移"
                        disabled={index === categories.length - 1}
                        onClick={() => handleMove(index, 1)}
                      >
                        ↓
                      </IconButton>
                      <button
                        onClick={() => {
                          setEditingId(category.id);
                          setEditingName(category.name);
                        }}
                        className="rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
                      >
                        改名
                      </button>
                      <button
                        onClick={() => handleDeleteClick(category)}
                        className="rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50"
                      >
                        刪除
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
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

/** 小型圖示按鈕（上移/下移）。 */
function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
