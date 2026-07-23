/**
 * 業務完成區塊（詳情頁最下方，僅未完成時顯示）。
 * - 單次業務：填完成日期（預設今天）＋ 完成說明，按「標記完成」並二次確認 → completeTask（鎖定）。
 * - 定期業務：主按鈕「完成本期」→ completeRecurringCycle（寫一筆本期完成進度、期限跳下一期，不鎖定）；
 *   另提供次要按鈕「結束定期並鎖定」→ completeTask（走原本鎖定流程）。
 * 純 UI + 事件捕捉；資料存取委由 taskService。
 */
import { useState } from 'react';
import { completeRecurringCycle, completeTask } from '../services/taskService';
import type { Task } from '../types/task';
import { describeRecurrence } from '../lib/recurrence';
import { nowTime, today } from '../lib/taskLogic';
import { Button, ErrorBanner, FieldLabel, INPUT_CLASS } from './ui';

interface CompletionSectionProps {
  task: Task;
}

export function CompletionSection({ task }: CompletionSectionProps) {
  const [date, setDate] = useState(today());
  const [time, setTime] = useState(nowTime());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isRecurring = task.recurrence !== null;

  /** 單次業務標記完成，或定期業務「結束定期並鎖定」共用的鎖定流程。 */
  async function handleComplete() {
    const message = isRecurring
      ? '確定結束此定期業務並鎖定？鎖定後將不再自動產生下一期，可日後解除。'
      : '確定標記此業務為已完成？完成後將鎖定，不可再修改（可日後解除）。';
    if (!window.confirm(message)) return;
    setSaving(true);
    setError(null);
    try {
      await completeTask(task.id, date, time || null, note.trim());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  /** 定期業務「完成本期」：寫一筆本期完成進度並將期限跳至下一期（不鎖定）。 */
  async function handleCompleteCycle() {
    if (task.recurrence === null) return;
    if (
      !window.confirm(
        `確定完成本期？將寫入一筆「本期完成」進度，期限自動跳至下一個週期日（${describeRecurrence(
          task.recurrence,
        )}）。`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await completeRecurringCycle(task, { date, time: time || null, note: note.trim() });
      // 完成本期後重設表單，方便下一期填寫。
      setNote('');
      setDate(today());
      setTime(nowTime());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-44">
          <FieldLabel>{isRecurring ? '本期完成日期' : '完成日期'}</FieldLabel>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="sm:w-32">
          <FieldLabel optional>{isRecurring ? '本期完成時間' : '完成時間'}</FieldLabel>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex-1">
          <FieldLabel optional>{isRecurring ? '本期說明' : '完成說明'}</FieldLabel>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={isRecurring ? '本期處理結果…' : '結案摘要 / 處理結果…'}
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <ErrorBanner message={error} />

      {isRecurring ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={handleComplete} disabled={saving}>
            結束定期並鎖定
          </Button>
          <Button onClick={handleCompleteCycle} disabled={saving}>
            {saving ? '處理中…' : '完成本期'}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button onClick={handleComplete} disabled={saving}>
            {saving ? '處理中…' : '標記完成'}
          </Button>
        </div>
      )}
    </div>
  );
}
