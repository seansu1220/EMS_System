/**
 * 業務清單的純邏輯（排序、篩選、期限計算、提醒彙整）。
 * 不依賴 React 或 Firebase，皆為純函式（輸入 → 輸出，無副作用），方便獨立測試。
 */
import type { ProgressEntry, Task } from '../types/task';
import { describeRecurrence } from './recurrence';

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
  /** 期限（yyyy-MM-dd）；null 代表無期限業務（永遠顯示於提醒卡末段）。 */
  deadline: string | null;
  /** 所屬屬性 ID。 */
  categoryId: string;
  /** 定期業務的週期中文描述（僅 kind='task' 且為定期業務時有值）。 */
  recurrenceLabel?: string;
}

/** 取得今天的 yyyy-MM-dd 字串（以本地時區計）。 */
export function today(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/** 取得當下的 HH:mm 字串（以本地時區計），比照 today()。 */
export function nowTime(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 日期字串加上 N 天，回傳 yyyy-MM-dd。
 * 以 T00:00:00 建立本地日期後用 setDate 位移，再取本地年月日，避免時區偏移。
 * @param dateStr 起始日期（yyyy-MM-dd）
 * @param days 位移天數（可為負）
 */
export function addDaysToDate(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00`);
  base.setDate(base.getDate() + days);
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 進度紀錄排序：日期新→舊；同日有時間者優先於無時間者，
 * 皆有時間時依時間新→舊；最後依 createdAt 新→舊。
 * 回傳新陣列，不改動輸入。
 */
export function sortProgressEntries(entries: ProgressEntry[]): ProgressEntry[] {
  return [...entries].sort((a, b) => {
    // 1) 日期新到舊。
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    // 2) 同日：有時間者排前面（無時間排該日最後）。
    const aHasTime = Boolean(a.time);
    const bHasTime = Boolean(b.time);
    if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
    // 3) 皆有時間：時間新到舊。
    if (aHasTime && bHasTime && a.time !== b.time) {
      return (b.time as string).localeCompare(a.time as string);
    }
    // 4) 最後依建立時間新到舊。
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
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

    // 2) 期限排序（此時 a、b 完成狀態相同）：
    //    未完成 → 無期限在前（易遺忘，優先曝光），其後依期限近到遠；
    //    已完成 → 維持原規則（有期限依近到遠，無期限排最後）。
    if (a.deadline && b.deadline) {
      if (a.deadline !== b.deadline) return a.deadline.localeCompare(b.deadline);
    } else if (a.deadline || b.deadline) {
      if (!doneA) return a.deadline ? 1 : -1;
      return a.deadline ? -1 : 1;
    }

    // 3) 最後依 updatedAt 新到舊。
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

/**
 * 取得提醒清單（統一項目型別）。
 * 來源：①未完成業務的期限；②未完成業務中「未勾掉且有期限」的待辦事項。
 * 納入規則：
 * - 有期限者：期限在 (今天 + withinDays) 之內（含逾期）才納入。
 * - 未完成且「無期限」的業務：一律納入（不受 withinDays 限制，deadline 為 null），避免被遺忘。
 * - 已完成業務、已勾掉的待辦、無期限的待辦事項皆不納入。
 * 排序：有期限者在前（依期限近到遠），無期限者集中在最後。
 * @param withinDays 未來幾天內到期納入提醒（逾期一律納入）
 */
export function getReminderTasks(tasks: Task[], withinDays: number): ReminderItem[] {
  const base = today();
  const items: ReminderItem[] = [];

  for (const task of tasks) {
    if (isDone(task)) continue;

    // 定期業務的週期中文描述（單次業務為 undefined）。
    const recurrenceLabel = task.recurrence ? describeRecurrence(task.recurrence) : undefined;

    // ① 業務本身：無期限一律納入（deadline=null）；有期限則須在視窗內。
    if (task.deadline === null) {
      items.push({
        kind: 'task',
        taskId: task.id,
        title: task.title,
        deadline: null,
        categoryId: task.categoryId,
        recurrenceLabel,
      });
    } else if (daysUntil(task.deadline, base) <= withinDays) {
      items.push({
        kind: 'task',
        taskId: task.id,
        title: task.title,
        deadline: task.deadline,
        categoryId: task.categoryId,
        recurrenceLabel,
      });
    }

    // ② 未勾掉且有期限的待辦事項（無期限待辦不納入）。
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

  // 有期限者在前（近到遠）；無期限者（null）集中排在最後。
  return items.sort((a, b) => {
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline || b.deadline) return a.deadline ? -1 : 1;
    return 0;
  });
}
