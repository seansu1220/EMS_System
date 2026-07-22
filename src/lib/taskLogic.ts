/**
 * 業務清單的純邏輯（排序、篩選、期限計算、提醒彙整）。
 * 不依賴 React 或 Firebase，皆為純函式（輸入 → 輸出，無副作用），方便獨立測試。
 */
import type { Task } from '../types/task';

/**
 * 首頁提醒項目（統一業務期限與待辦事項兩種來源）。
 * - kind='task'：title 為業務名稱。
 * - kind='checklist'：title 為待辦內容，taskTitle 為所屬業務名稱。
 */
export interface ReminderItem {
  kind: 'task' | 'checklist';
  /** 所屬業務的文件 ID（點擊跳轉用）。 */
  taskId: string;
  /** 顯示標題（業務名稱，或待辦內容）。 */
  title: string;
  /** 待辦項目所屬的業務名稱（僅 kind='checklist' 時有值）。 */
  taskTitle?: string;
  /** 期限（yyyy-MM-dd）。 */
  deadline: string;
  /** 所屬屬性 ID。 */
  categoryId: string;
}

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
  return task.completed;
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
 * 取得提醒清單（統一項目型別）：期限在 (今天 + withinDays) 之內（含逾期）者納入，依期限近到遠排序。
 * 來源：①未完成業務的期限；②未完成業務中「未勾掉且有期限」的待辦事項。
 * （已完成業務、已勾掉的待辦、無期限者皆不納入。）
 * @param withinDays 未來幾天內到期納入提醒（逾期一律納入）
 */
export function getReminderTasks(tasks: Task[], withinDays: number): ReminderItem[] {
  const base = today();
  const items: ReminderItem[] = [];

  for (const task of tasks) {
    if (isDone(task)) continue;

    // ① 業務本身的期限。
    if (task.deadline && daysUntil(task.deadline, base) <= withinDays) {
      items.push({
        kind: 'task',
        taskId: task.id,
        title: task.title,
        deadline: task.deadline,
        categoryId: task.categoryId,
      });
    }

    // ② 未勾掉且有期限的待辦事項。
    for (const item of task.checklistItems) {
      if (item.done || !item.deadline) continue;
      if (daysUntil(item.deadline, base) > withinDays) continue;
      items.push({
        kind: 'checklist',
        taskId: task.id,
        title: item.content,
        taskTitle: task.title,
        deadline: item.deadline,
        categoryId: task.categoryId,
      });
    }
  }

  return items.sort((a, b) => a.deadline.localeCompare(b.deadline));
}
