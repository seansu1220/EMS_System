/**
 * 業務新增/編輯共用表單（純 UI + 事件捕捉，資料存取僅限即時新增屬性）。
 * 由 NewTaskPage 與 TaskDetailPage 提供 categories、ownerUid、初始值與 onSubmit。
 * disabled=true 時整張表單鎖定（業務已完成），僅供檢視。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Category } from '../types/category';
import type { RecurrenceRule, TaskDraft } from '../types/task';
import { createCategory } from '../services/categoryService';
import { addDaysToDate, today } from '../lib/taskLogic';
import { nextOccurrence } from '../lib/recurrence';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

/** 下拉選單中「＋ 新增屬性…」的特殊值。 */
const NEW_CATEGORY_VALUE = '__new_category__';

/** 週期型別選項（含「單次業務」＝無週期）。 */
type RecurrenceKind = 'none' | RecurrenceRule['type'];

const RECURRENCE_OPTIONS: readonly { value: RecurrenceKind; label: string }[] = [
  { value: 'none', label: '單次業務' },
  { value: 'monthly', label: '每月固定日' },
  { value: 'weekly', label: '每週固定星期' },
  { value: 'everyNDays', label: '每 N 天一次' },
  { value: 'yearly', label: '每年固定日期' },
];

/** 星期下拉選項（0=日 … 6=六）。 */
const WEEKDAY_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: '星期日' },
  { value: 1, label: '星期一' },
  { value: 2, label: '星期二' },
  { value: 3, label: '星期三' },
  { value: 4, label: '星期四' },
  { value: 5, label: '星期五' },
  { value: 6, label: '星期六' },
];

/** 週期表單的字串型輸入狀態（允許暫時為空，送出時才驗證/轉型）。 */
interface RecurrenceFormState {
  kind: RecurrenceKind;
  /** monthly：每月第幾號（字串）。 */
  monthlyDay: string;
  /** weekly：星期幾（0-6）。 */
  weeklyWeekday: number;
  /** everyNDays：每 N 天（字串）。 */
  everyNDays: string;
  /** yearly：月份（字串）。 */
  yearlyMonth: string;
  /** yearly：日（字串）。 */
  yearlyDay: string;
}

/** 由既有週期規則建立週期表單狀態（缺漏時套用預設值）。 */
function buildRecurrenceState(rule: RecurrenceRule | null | undefined): RecurrenceFormState {
  const base: RecurrenceFormState = {
    kind: 'none',
    monthlyDay: '1',
    weeklyWeekday: 1,
    everyNDays: '7',
    yearlyMonth: '1',
    yearlyDay: '1',
  };
  if (!rule) return base;
  switch (rule.type) {
    case 'monthly':
      return { ...base, kind: 'monthly', monthlyDay: String(rule.day) };
    case 'weekly':
      return { ...base, kind: 'weekly', weeklyWeekday: rule.weekday };
    case 'everyNDays':
      return { ...base, kind: 'everyNDays', everyNDays: String(rule.n) };
    case 'yearly':
      return { ...base, kind: 'yearly', yearlyMonth: String(rule.month), yearlyDay: String(rule.day) };
    default:
      return base;
  }
}

/**
 * 由週期表單狀態解析出週期規則，並做參數驗證。
 * 回傳 { ok:true, rule } 或 { ok:false, message }（message 為中文錯誤，供 setError 顯示）。
 */
function resolveRecurrence(
  state: RecurrenceFormState,
): { ok: true; rule: RecurrenceRule | null } | { ok: false; message: string } {
  const parseIntInRange = (raw: string, min: number, max: number): number | null => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return null;
    return value;
  };
  switch (state.kind) {
    case 'none':
      return { ok: true, rule: null };
    case 'monthly': {
      const day = parseIntInRange(state.monthlyDay, 1, 31);
      if (day === null) return { ok: false, message: '每月的日期請輸入 1 到 31 的整數。' };
      return { ok: true, rule: { type: 'monthly', day } };
    }
    case 'weekly':
      return { ok: true, rule: { type: 'weekly', weekday: state.weeklyWeekday } };
    case 'everyNDays': {
      const n = Number(state.everyNDays);
      if (!Number.isInteger(n) || n < 1) return { ok: false, message: '「每 N 天」請輸入 1 以上的正整數。' };
      return { ok: true, rule: { type: 'everyNDays', n } };
    }
    case 'yearly': {
      const month = parseIntInRange(state.yearlyMonth, 1, 12);
      if (month === null) return { ok: false, message: '每年的月份請輸入 1 到 12 的整數。' };
      const day = parseIntInRange(state.yearlyDay, 1, 31);
      if (day === null) return { ok: false, message: '每年的日期請輸入 1 到 31 的整數。' };
      return { ok: true, rule: { type: 'yearly', month, day } };
    }
    default:
      return { ok: true, rule: null };
  }
}

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
    recurrence: initial?.recurrence ?? null,
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
  // 週期表單以獨立字串狀態管理（允許輸入中暫時為空），送出時才解析為 RecurrenceRule。
  const [recurrence, setRecurrence] = useState<RecurrenceFormState>(() =>
    buildRecurrenceState(initial?.recurrence),
  );
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

  /** 更新週期表單的單一欄位。 */
  function updateRecurrence<K extends keyof RecurrenceFormState>(
    key: K,
    value: RecurrenceFormState[K],
  ) {
    setRecurrence((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * 解析週期並套用到草稿：驗證失敗時設錯誤並回傳 null；
   * 若選了週期且期限留空，自動帶入下一個週期日（含當天）作為本期期限。
   */
  function applyRecurrenceToDraft(target: TaskDraft): TaskDraft | null {
    const resolved = resolveRecurrence(recurrence);
    if (!resolved.ok) {
      setError(resolved.message);
      return null;
    }
    let next: TaskDraft = { ...target, recurrence: resolved.rule };
    if (resolved.rule && !next.deadline) {
      next = { ...next, deadline: nextOccurrence(resolved.rule, today(), { inclusive: true }) };
    }
    return next;
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
    const resolved = applyRecurrenceToDraft(draft);
    if (!resolved) return;
    await submitDraft(resolved);
  }

  /** 展期確認：新期限 = 目前期限 + N 天，更新草稿並立即送出整張表單。 */
  async function handleExtendConfirm(days: number) {
    if (!draft.deadline || days <= 0) return;
    const withRecurrence = applyRecurrenceToDraft(draft);
    if (!withRecurrence) return;
    const nextDraft: TaskDraft = {
      ...withRecurrence,
      deadline: addDaysToDate(draft.deadline, days),
    };
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
        <FieldLabel optional>週期</FieldLabel>
        <select
          value={recurrence.kind}
          onChange={(e) => updateRecurrence('kind', e.target.value as RecurrenceKind)}
          className={INPUT_CLASS}
          disabled={disabled}
        >
          {RECURRENCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {/* 依所選週期型別顯示對應參數輸入。 */}
        {recurrence.kind === 'monthly' && (
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            <span>每月</span>
            <input
              type="number"
              min={1}
              max={31}
              step={1}
              value={recurrence.monthlyDay}
              onChange={(e) => updateRecurrence('monthlyDay', e.target.value)}
              className={`${INPUT_CLASS} w-24`}
              disabled={disabled}
            />
            <span>號</span>
          </div>
        )}
        {recurrence.kind === 'weekly' && (
          <div className="mt-2">
            <select
              value={recurrence.weeklyWeekday}
              onChange={(e) => updateRecurrence('weeklyWeekday', Number(e.target.value))}
              className={INPUT_CLASS}
              disabled={disabled}
            >
              {WEEKDAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {recurrence.kind === 'everyNDays' && (
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            <span>每</span>
            <input
              type="number"
              min={1}
              step={1}
              value={recurrence.everyNDays}
              onChange={(e) => updateRecurrence('everyNDays', e.target.value)}
              className={`${INPUT_CLASS} w-24`}
              disabled={disabled}
            />
            <span>天一次</span>
          </div>
        )}
        {recurrence.kind === 'yearly' && (
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            <span>每年</span>
            <input
              type="number"
              min={1}
              max={12}
              step={1}
              value={recurrence.yearlyMonth}
              onChange={(e) => updateRecurrence('yearlyMonth', e.target.value)}
              className={`${INPUT_CLASS} w-20`}
              disabled={disabled}
            />
            <span>月</span>
            <input
              type="number"
              min={1}
              max={31}
              step={1}
              value={recurrence.yearlyDay}
              onChange={(e) => updateRecurrence('yearlyDay', e.target.value)}
              className={`${INPUT_CLASS} w-20`}
              disabled={disabled}
            />
            <span>日</span>
          </div>
        )}
        {recurrence.kind !== 'none' && !draft.deadline && (
          <p className="mt-1 text-xs text-slate-400">期限留空將自動帶入下一個週期日。</p>
        )}
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
