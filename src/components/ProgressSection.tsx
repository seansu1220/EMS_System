/**
 * 業務進度管理區塊。
 * 可新增多筆進度紀錄（日期選擇器 + 內容），由新到舊顯示，可刪除單筆。
 * 純 UI + 事件捕捉；資料存取委由 taskService。
 */
import { useState } from 'react';
import { addProgressEntry, deleteProgressEntry } from '../services/taskService';
import type { Task } from '../types/task';
import { today } from '../lib/taskLogic';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

interface ProgressSectionProps {
  task: Task;
}

/** 進度排序鍵：先日期、後建立時間（皆新到舊）。 */
function sortKey(entry: { date: string; createdAt: string }): string {
  return `${entry.date} ${entry.createdAt}`;
}

export function ProgressSection({ task }: ProgressSectionProps) {
  const [date, setDate] = useState(today());
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sorted = [...task.progressEntries].sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  async function handleAdd() {
    if (!content.trim()) {
      setError('請填寫進度內容。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addProgressEntry(task, { date, content: content.trim() });
      setContent('');
      setDate(today());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entryId: string) {
    if (!window.confirm('確定刪除這筆進度紀錄？')) return;
    setError(null);
    try {
      await deleteProgressEntry(task, entryId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-44">
          <FieldLabel>日期</FieldLabel>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex-1">
          <FieldLabel>進度內容</FieldLabel>
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例如：已詢價 / 已送簽 / 待廠商回覆…"
            className={INPUT_CLASS}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
          />
        </div>
        <Button onClick={handleAdd} disabled={saving}>
          {saving ? '處理中…' : '新增進度'}
        </Button>
      </div>

      <ErrorBanner message={error} />

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-400">尚無進度紀錄。</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {sorted.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
              <span className="w-24 shrink-0 font-mono text-sm text-slate-500">{entry.date}</span>
              <span className="flex-1 whitespace-pre-wrap text-sm text-slate-700">
                {entry.content}
              </span>
              <button
                onClick={() => handleDelete(entry.id)}
                className="shrink-0 text-xs text-red-500 hover:underline"
              >
                刪除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
