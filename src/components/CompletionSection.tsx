/**
 * 業務完成區塊（詳情頁最下方，僅未完成時顯示）。
 * 填完成日期（預設今天）＋ 完成說明，按「標記完成」並二次確認 → completeTask。
 * 純 UI + 事件捕捉；資料存取委由 taskService。
 */
import { useState } from 'react';
import { completeTask } from '../services/taskService';
import type { Task } from '../types/task';
import { today } from '../lib/taskLogic';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

interface CompletionSectionProps {
  task: Task;
}

export function CompletionSection({ task }: CompletionSectionProps) {
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleComplete() {
    if (!window.confirm('確定標記此業務為已完成？完成後將鎖定，不可再修改（可日後解除）。')) return;
    setSaving(true);
    setError(null);
    try {
      await completeTask(task.id, date, note.trim());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-44">
          <FieldLabel>完成日期</FieldLabel>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex-1">
          <FieldLabel optional>完成說明</FieldLabel>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="結案摘要 / 處理結果…"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <ErrorBanner message={error} />

      <div className="flex justify-end">
        <Button onClick={handleComplete} disabled={saving}>
          {saving ? '處理中…' : '標記完成'}
        </Button>
      </div>
    </div>
  );
}
