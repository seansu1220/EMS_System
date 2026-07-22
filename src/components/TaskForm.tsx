/**
 * 業務新增/編輯共用表單（純 UI + 事件捕捉，資料存取僅限即時新增屬性）。
 * 由 NewTaskPage 與 TaskDetailPage 提供 categories、ownerUid、初始值與 onSubmit。
 * disabled=true 時整張表單鎖定（業務已完成），僅供檢視。
 */
import { useState, type FormEvent } from 'react';
import type { Category } from '../types/category';
import type { TaskDraft } from '../types/task';
import { createCategory } from '../services/categoryService';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

/** 下拉選單中「＋ 新增屬性…」的特殊值。 */
const NEW_CATEGORY_VALUE = '__new_category__';

interface TaskFormProps {
  categories: Category[];
  /** 目前登入者 uid（即時新增屬性時帶入 ownerUid）。 */
  ownerUid: string;
  /** 編輯時的初始值；新增時可省略。 */
  initial?: Partial<TaskDraft>;
  /** 送出時的動作（回傳 Promise，失敗時 throw Error 由本元件顯示訊息）。 */
  onSubmit: (draft: TaskDraft) => Promise<void>;
  /** 取消按鈕動作。 */
  onCancel: () => void;
  /** 送出按鈕文字。 */
  submitLabel: string;
  /** 是否鎖定（業務已完成，所有欄位停用且隱藏送出/取消）。 */
  disabled?: boolean;
}

/** 依初始值建立表單狀態（缺漏時套用預設）。 */
function buildInitialDraft(initial?: Partial<TaskDraft>): TaskDraft {
  return {
    title: initial?.title ?? '',
    categoryId: initial?.categoryId ?? '',
    description: initial?.description ?? '',
    deadline: initial?.deadline ?? null,
    note: initial?.note ?? '',
  };
}

export function TaskForm({
  categories,
  ownerUid,
  initial,
  onSubmit,
  onCancel,
  submitLabel,
  disabled = false,
}: TaskFormProps) {
  const [draft, setDraft] = useState<TaskDraft>(() => buildInitialDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 表單內即時新增屬性的狀態。
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);

  function update<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  /** 屬性下拉選擇：選到「＋ 新增屬性…」時開啟行內輸入。 */
  function handleCategorySelect(value: string) {
    if (value === NEW_CATEGORY_VALUE) {
      setAddingCategory(true);
      setNewCategoryName('');
      setCategoryError(null);
      return;
    }
    setAddingCategory(false);
    update('categoryId', value);
  }

  /** 建立新屬性：擋空白與重複名稱，成功後自動選取並收合輸入框。 */
  async function handleCreateCategory() {
    const name = newCategoryName.trim();
    if (!name) {
      setCategoryError('請輸入屬性名稱。');
      return;
    }
    if (categories.some((category) => category.name.trim().toLowerCase() === name.toLowerCase())) {
      setCategoryError('已有相同名稱的屬性。');
      return;
    }
    setCreatingCategory(true);
    setCategoryError(null);
    try {
      const maxOrder = categories.reduce((max, category) => Math.max(max, category.sortOrder), -1);
      const newId = await createCategory(name, maxOrder + 1, ownerUid);
      update('categoryId', newId);
      setAddingCategory(false);
      setNewCategoryName('');
    } catch (err) {
      setCategoryError((err as Error).message);
    } finally {
      setCreatingCategory(false);
    }
  }

  /** 取消新增屬性：恢復原本的下拉選取。 */
  function handleCancelAddCategory() {
    setAddingCategory(false);
    setNewCategoryName('');
    setCategoryError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim()) {
      setError('請填寫業務名稱。');
      return;
    }
    if (!draft.categoryId) {
      setError('請選擇屬性。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ ...draft, title: draft.title.trim() });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <FieldLabel required>業務名稱</FieldLabel>
        <input
          type="text"
          value={draft.title}
          onChange={(e) => update('title', e.target.value)}
          className={INPUT_CLASS}
          placeholder="例如：採購 AED 電池"
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex-1">
          <FieldLabel required>屬性</FieldLabel>
          <select
            value={addingCategory ? NEW_CATEGORY_VALUE : draft.categoryId}
            onChange={(e) => handleCategorySelect(e.target.value)}
            className={INPUT_CLASS}
            disabled={disabled}
          >
            <option value="">請選擇屬性</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
            <option value={NEW_CATEGORY_VALUE}>＋ 新增屬性…</option>
          </select>
          {addingCategory && (
            <div className="mt-2 space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="輸入新屬性名稱"
                  className={INPUT_CLASS}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCreateCategory();
                    }
                  }}
                />
                <Button type="button" onClick={handleCreateCategory} disabled={creatingCategory}>
                  {creatingCategory ? '新增中…' : '新增'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleCancelAddCategory}
                  disabled={creatingCategory}
                >
                  取消
                </Button>
              </div>
              <ErrorBanner message={categoryError} />
            </div>
          )}
        </div>
        <div className="sm:w-40">
          <FieldLabel optional>期限</FieldLabel>
          <input
            type="date"
            value={draft.deadline ?? ''}
            onChange={(e) => update('deadline', e.target.value || null)}
            className={INPUT_CLASS}
            disabled={disabled}
          />
        </div>
      </div>

      <div>
        <FieldLabel optional>業務說明</FieldLabel>
        <textarea
          rows={3}
          value={draft.description}
          onChange={(e) => update('description', e.target.value)}
          className={INPUT_CLASS}
          placeholder="業務的詳細說明…"
          disabled={disabled}
        />
      </div>

      <div>
        <FieldLabel optional>備註</FieldLabel>
        <textarea
          rows={2}
          value={draft.note}
          onChange={(e) => update('note', e.target.value)}
          className={INPUT_CLASS}
          placeholder="其他備註…"
          disabled={disabled}
        />
      </div>

      <ErrorBanner message={error} />

      {!disabled && (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? '儲存中…' : submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
