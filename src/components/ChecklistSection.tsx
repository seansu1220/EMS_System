/**
 * 業務待辦事項（checklist）區塊。
 * 可新增（內容 + 可選期限）、勾選完成、刪除；
 * 排列：未勾在前（期限近到遠、無期限在後），已勾在後。
 * 逾期且未勾以紅色、urgent 天數內以橙色標示期限。
 * 純 UI + 事件捕捉；資料存取委由 taskService（更新 task 文件的 checklistItems 陣列）。
 */
import { useState } from 'react';
import {
  addChecklistItem,
  removeChecklistItem,
  toggleChecklistItem,
} from '../services/taskService';
import type { ChecklistItem, Task } from '../types/task';
import { daysUntil } from '../lib/taskLogic';
import { REMINDER_DAYS } from '../config/constants';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

interface ChecklistSectionProps {
  task: Task;
  /** 是否鎖定（業務已完成，不可新增/勾選/刪除）。 */
  locked?: boolean;
}

/**
 * 待辦排序：未勾在前；同組內依期限近到遠（無期限排最後）；再依建立時間。
 */
function compareChecklist(a: ChecklistItem, b: ChecklistItem): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.deadline && b.deadline) {
    if (a.deadline !== b.deadline) return a.deadline.localeCompare(b.deadline);
  } else if (a.deadline || b.deadline) {
    return a.deadline ? -1 : 1;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

/** 未勾待辦依剩餘天數決定期限文字顏色。 */
function deadlineToneClass(deadline: string): string {
  const remaining = daysUntil(deadline);
  if (remaining < 0) return 'text-red-600 font-semibold';
  if (remaining <= REMINDER_DAYS.urgent) return 'text-amber-600 font-semibold';
  return 'text-slate-500';
}

export function ChecklistSection({ task, locked = false }: ChecklistSectionProps) {
  const [content, setContent] = useState('');
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sorted = [...task.checklistItems].sort(compareChecklist);

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

  async function handleToggle(itemId: string) {
    setError(null);
    try {
      await toggleChecklistItem(task, itemId);
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

  return (
    <div className="space-y-4">
      {!locked && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <FieldLabel>待辦內容</FieldLabel>
            <input
              type="text"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="例如：確認規格 / 補齊附件 / 追進度…"
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

      <ErrorBanner message={error} />

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-400">尚無待辦事項。</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {sorted.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0"
                checked={item.done}
                disabled={locked}
                onChange={() => handleToggle(item.id)}
              />
              <span
                className={`flex-1 whitespace-pre-wrap text-sm ${
                  item.done ? 'text-slate-400 line-through' : 'text-slate-700'
                }`}
              >
                {item.content}
              </span>
              {item.deadline && (
                <span
                  className={`shrink-0 font-mono text-xs ${
                    item.done ? 'text-slate-400 line-through' : deadlineToneClass(item.deadline)
                  }`}
                >
                  {item.deadline}
                </span>
              )}
              {!locked && (
                <button
                  onClick={() => handleRemove(item.id)}
                  className="shrink-0 text-xs text-red-500 hover:underline"
                >
                  刪除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
