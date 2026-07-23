/**
 * 業務新增/編輯共用表單（純 UI + 事件捕捉，資料存取僅限即時新增屬性）。
 * 由 NewTaskPage 與 TaskDetailPage 提供 categories、ownerUid、初始值與 onSubmit。
 * disabled=true 時整張表單鎖定（業務已完成），僅供檢視。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Category } from '../types/category';
import type { TaskDraft } from '../types/task';
import { createCategory } from '../services/categoryService';
import { addDaysToDate } from '../lib/taskLogic';
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
  /** 是否顯示期限「展期」按鈕（僅編輯模式；新增頁不需）。 */
  showExtend?: boolean;
}

/** 展期快選天數選項。 */
const EXTEND_QUICK_DAYS = [1, 3, 7] as const;

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
  showExtend = false,
}: TaskFormProps) {
  const [draft, setDraft] = useState<TaskDraft>(() => buildInitialDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  // 展期行內選單狀態。
  const [extending, setExtending] = useState(false);
  const [extendDays, setExtendDays] = useState('');

  // 「已儲存」提示的計時器；元件卸載前清除，避免對已卸載元件 setState。
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

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

  /** 驗證並送出指定草稿；成功後恢復按鈕並短暫顯示「已儲存」。 */
  async function submitDraft(target: TaskDraft) {
    if (!target.title.trim()) {
      setError('請填寫業務名稱。');
      return;
    }
    if (!target.categoryId) {
      setError('請選擇屬性。');
      return;
    }
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      await onSubmit({ ...target, title: target.title.trim() });
      // 成功路徑同樣恢復按鈕（修正卡在「儲存中」的 bug），並顯示 2 秒「已儲存」提示。
      setSubmitting(false);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await submitDraft(draft);
  }

  /** 展期確認：新期限 = 目前期限 + N 天，更新草稿並立即送出整張表單。 */
  async function handleExtendConfirm(days: number) {
    if (!draft.deadline || days <= 0) return;
    const nextDraft: TaskDraft = { ...draft, deadline: addDaysToDate(draft.deadline, days) };
    setDraft(nextDraft);
    setExtending(false);
    setExtendDays('');
    await submitDraft(nextDraft);
  }

  /** 自訂天數展期：解析正整數後套用。 */
  function handleExtendCustom() {
    const days = Number(extendDays);
    if (!Number.isInteger(days) || days <= 0) {
      setError('請輸入正整數天數。');
      return;
    }
    void handleExtendConfirm(days);
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
          {showExtend && !disabled && draft.deadline && !extending && (
            <button
              type="button"
              onClick={() => {
                setExtending(true);
                setExtendDays('');
                setError(null);
              }}
              className="mt-1 text-xs text-slate-500 hover:underline"
            >
              展期
            </button>
          )}
          {showExtend && !disabled && draft.deadline && extending && (
            <div className="mt-2 space-y-2 rounded-lg border border-slate-200 p-2">
              <p className="text-xs text-slate-500">選擇展延天數（將立即儲存）：</p>
              <div className="flex flex-wrap gap-1">
                {EXTEND_QUICK_DAYS.map((days) => (
                  <Button
                    key={days}
                    type="button"
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={() => handleExtendConfirm(days)}
                    disabled={submitting}
                  >
                    +{days} 天
                  </Button>
                ))}
              </div>
              <div className="flex gap-1">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={extendDays}
                  onChange={(e) => setExtendDays(e.target.value)}
                  placeholder="自訂天數"
                  className={INPUT_CLASS}
                />
                <Button
                  type="button"
                  className="px-2 py-1 text-xs"
                  onClick={handleExtendCustom}
                  disabled={submitting}
                >
                  確定
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="px-2 py-1 text-xs"
                  onClick={() => {
                    setExtending(false);
                    setExtendDays('');
                  }}
                  disabled={submitting}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
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
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-sm font-medium text-green-600">已儲存</span>}
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
