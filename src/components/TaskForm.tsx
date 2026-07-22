/**
 * 業務新增/編輯共用表單（純 UI + 事件捕捉，不含資料存取）。
 * 由 NewTaskPage 與 TaskDetailPage 提供 categories、初始值與 onSubmit。
 */
import { useState, type FormEvent } from 'react';
import type { Category } from '../types/category';
import type { TaskDraft } from '../types/task';
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
} from '../config/constants';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

interface TaskFormProps {
  categories: Category[];
  /** 編輯時的初始值；新增時可省略。 */
  initial?: Partial<TaskDraft>;
  /** 送出時的動作（回傳 Promise，失敗時 throw Error 由本元件顯示訊息）。 */
  onSubmit: (draft: TaskDraft) => Promise<void>;
  /** 取消按鈕動作。 */
  onCancel: () => void;
  /** 送出按鈕文字。 */
  submitLabel: string;
}

/** 依初始值建立表單狀態（缺漏時套用預設）。 */
function buildInitialDraft(initial?: Partial<TaskDraft>): TaskDraft {
  return {
    title: initial?.title ?? '',
    categoryId: initial?.categoryId ?? '',
    description: initial?.description ?? '',
    deadline: initial?.deadline ?? null,
    priority: initial?.priority ?? DEFAULT_PRIORITY,
    status: initial?.status ?? DEFAULT_STATUS,
    note: initial?.note ?? '',
  };
}

export function TaskForm({ categories, initial, onSubmit, onCancel, submitLabel }: TaskFormProps) {
  const [draft, setDraft] = useState<TaskDraft>(() => buildInitialDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
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
        />
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex-1">
          <FieldLabel required>屬性</FieldLabel>
          <select
            value={draft.categoryId}
            onChange={(e) => update('categoryId', e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">請選擇屬性</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:w-40">
          <FieldLabel optional>期限</FieldLabel>
          <input
            type="date"
            value={draft.deadline ?? ''}
            onChange={(e) => update('deadline', e.target.value || null)}
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex-1">
          <FieldLabel>優先度</FieldLabel>
          <select
            value={draft.priority}
            onChange={(e) => update('priority', e.target.value as TaskDraft['priority'])}
            className={INPUT_CLASS}
          >
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <FieldLabel>狀態</FieldLabel>
          <select
            value={draft.status}
            onChange={(e) => update('status', e.target.value as TaskDraft['status'])}
            className={INPUT_CLASS}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
        />
      </div>

      <ErrorBanner message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? '儲存中…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
