/**
 * 待辦事項（checklist）的純邏輯：排序模式、順序正規化、完成進度統計。
 * 不依賴 React 或 Firebase，皆為純函式（輸入 → 輸出，無副作用），方便獨立測試。
 */
import type { ChecklistItem } from '../types/task';
import { REMINDER_WORKDAYS } from '../config/constants';
import { daysUntil } from './taskLogic';
import { workdaysUntil, type WorkdayCalendar } from './workday';

/**
 * 待辦排序模式（配置驅動，UI 由 CHECKLIST_SORT_MODES 產生切換選項）。
 * - custom：流程順序（依 sortOrder，適合標案等有先後關卡的業務）。
 * - deadline：依期限（未勾在前、期限近到遠、無期限最後）。
 */
export type ChecklistSortMode = 'custom' | 'deadline';

/** 排序模式的中文標籤（供切換按鈕顯示）。 */
export const CHECKLIST_SORT_MODES: readonly { value: ChecklistSortMode; label: string }[] = [
  { value: 'custom', label: '流程順序' },
  { value: 'deadline', label: '依期限' },
];

/** 待辦完成進度統計。 */
export interface ChecklistProgress {
  /** 總項目數。 */
  total: number;
  /** 已勾選數。 */
  done: number;
  /** 完成百分比（0-100 整數；無項目時為 0）。 */
  percent: number;
}

/**
 * 由原始資料補齊 sortOrder（舊資料無此欄位時以陣列索引遞補）。
 * 回傳新陣列，不改動輸入。
 * @param items 可能缺 sortOrder 的待辦陣列
 */
export function withChecklistOrder(
  items: (Omit<ChecklistItem, 'sortOrder'> & { sortOrder?: number })[],
): ChecklistItem[] {
  return items.map((item, index) => ({
    ...item,
    sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : index,
  }));
}

/** 新項目要用的 sortOrder（現有最大值 + 1；空清單為 0）。 */
export function nextChecklistSortOrder(items: ChecklistItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
}

/** 流程順序比較：sortOrder 小者在前，相同時依建立時間。 */
function compareByOrder(a: ChecklistItem, b: ChecklistItem): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return (a.createdAt || '').localeCompare(b.createdAt || '');
}

/** 期限比較：未勾在前；同組內依期限近到遠（無期限排最後）；再依建立時間。 */
function compareByDeadline(a: ChecklistItem, b: ChecklistItem): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.deadline && b.deadline) {
    if (a.deadline !== b.deadline) return a.deadline.localeCompare(b.deadline);
  } else if (a.deadline || b.deadline) {
    return a.deadline ? -1 : 1;
  }
  return (a.createdAt || '').localeCompare(b.createdAt || '');
}

/**
 * 依模式排序待辦事項。回傳新陣列，不改動輸入。
 * custom 模式不把已勾項目移到最後，讓流程的先後關係維持在原位置。
 */
export function sortChecklistItems(
  items: ChecklistItem[],
  mode: ChecklistSortMode,
): ChecklistItem[] {
  return [...items].sort(mode === 'custom' ? compareByOrder : compareByDeadline);
}

/** 計算待辦完成進度。 */
export function checklistProgress(items: ChecklistItem[]): ChecklistProgress {
  const total = items.length;
  const done = items.filter((item) => item.done).length;
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * 未勾待辦依剩餘天數決定期限文字色調 class。
 * 逾期紅色、剩餘工作日在 REMINDER_WORKDAYS.urgent 內橙色，其餘灰色。
 * 剩餘量與提醒卡一致，以工作日計算（週五看到下週一到期即為剩 1 個工作日 → 橙色）。
 */
export function checklistDeadlineToneClass(deadline: string, calendar: WorkdayCalendar): string {
  if (daysUntil(deadline) < 0) return 'text-red-600 font-semibold';
  if (workdaysUntil(deadline, calendar) <= REMINDER_WORKDAYS.urgent) {
    return 'text-amber-600 font-semibold';
  }
  return 'text-slate-500';
}
