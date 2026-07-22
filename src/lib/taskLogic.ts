/**
 * 業務清單的純邏輯（排序、篩選、期限計算）。
 * 不依賴 React 或 Firebase，皆為純函式（輸入 → 輸出，無副作用），方便獨立測試。
 */
import type { Task } from '../types/task';
import { DONE_STATUS } from '../config/constants';

/** 取得今天的 yyyy-MM-dd 字串（以本地時區計）。 */
export function today(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * 計算距離期限的天數（以本地日期為基準）。
 * 回傳正數＝還有幾天到期；0＝今天到期；負數＝已逾期幾天。
 * @param deadline yyyy-MM-dd
 */
export function daysUntil(deadline: string, from: string = today()): number {
  const target = new Date(`${deadline}T00:00:00`);
  const base = new Date(`${from}T00:00:00`);
  const diffMs = target.getTime() - base.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

/** 業務是否已完成。 */
export function isDone(task: Task): boolean {
  return task.status === DONE_STATUS;
}

/** 業務是否已逾期（有期限、未完成、期限早於今天）。 */
export function isOverdue(task: Task): boolean {
  if (!task.deadline || isDone(task)) return false;
  return daysUntil(task.deadline) < 0;
}

/**
 * 業務列表排序：未完成在前；其次依期限近到遠（無期限排最後）；再依 updatedAt（新到舊）。
 * 回傳新陣列，不改動輸入。
 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    // 1) 未完成優先。
    const doneA = isDone(a);
    const doneB = isDone(b);
    if (doneA !== doneB) return doneA ? 1 : -1;

    // 2) 期限近到遠；無期限（null）排在有期限之後。
    if (a.deadline && b.deadline) {
      if (a.deadline !== b.deadline) return a.deadline.localeCompare(b.deadline);
    } else if (a.deadline || b.deadline) {
      return a.deadline ? -1 : 1;
    }

    // 3) 最後依 updatedAt 新到舊。
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

/**
 * 取得提醒清單：未完成、有期限，且期限在 (今天 + withinDays) 之內（含逾期）。
 * 依期限由近到遠排序。
 * @param withinDays 未來幾天內到期納入提醒（逾期一律納入）
 */
export function getReminderTasks(tasks: Task[], withinDays: number): Task[] {
  const base = today();
  return tasks
    .filter((task) => {
      if (isDone(task) || !task.deadline) return false;
      return daysUntil(task.deadline, base) <= withinDays;
    })
    .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''));
}
