/**
 * 全域常數（配置驅動）。
 * 集中管理集合名稱、狀態/優先度選項（含中文標籤與顏色）、提醒天數、預設屬性，
 * 避免這些業務參數散落在各元件中出現魔術字串/數字。
 */
import type { TaskPriority, TaskStatus } from '../types/task';

/** 應用程式名稱。 */
export const APP_NAME = '救護科業務管理系統';

/** Firestore 集合名稱。 */
export const COLLECTIONS = {
  users: 'users',
  categories: 'categories',
  tasks: 'tasks',
} as const;

/** UI 色調鍵（對應 ui.tsx 的 Badge tone / 文字顏色樣式）。 */
export type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue';

/** 選項定義：值 + 中文標籤 + 顯示色調。 */
export interface Option<T extends string> {
  value: T;
  label: string;
  tone: Tone;
}

/** 優先度選項（含中文標籤與色調），依顯示順序排列。 */
export const PRIORITY_OPTIONS: readonly Option<TaskPriority>[] = [
  { value: 'high', label: '高', tone: 'red' },
  { value: 'medium', label: '中', tone: 'amber' },
  { value: 'low', label: '低', tone: 'slate' },
] as const;

/** 狀態選項（含中文標籤與色調），依顯示順序排列。 */
export const STATUS_OPTIONS: readonly Option<TaskStatus>[] = [
  { value: 'todo', label: '未開始', tone: 'slate' },
  { value: 'in_progress', label: '進行中', tone: 'blue' },
  { value: 'done', label: '已完成', tone: 'green' },
  { value: 'on_hold', label: '擱置', tone: 'amber' },
] as const;

/** 代表「已完成」的狀態值（單一來源，供邏輯判斷用）。 */
export const DONE_STATUS: TaskStatus = 'done';

/** 預設優先度。 */
export const DEFAULT_PRIORITY: TaskPriority = 'medium';

/** 預設狀態。 */
export const DEFAULT_STATUS: TaskStatus = 'todo';

/** 依 value 取得優先度選項（找不到回傳 undefined）。 */
export function getPriorityOption(value: string): Option<TaskPriority> | undefined {
  return PRIORITY_OPTIONS.find((option) => option.value === value);
}

/** 依 value 取得狀態選項（找不到回傳 undefined）。 */
export function getStatusOption(value: string): Option<TaskStatus> | undefined {
  return STATUS_OPTIONS.find((option) => option.value === value);
}

/**
 * 提醒天數門檻。
 * - default：預設提醒範圍（逾期 + 7 天內到期）。
 * - expanded：展開後的提醒範圍（逾期 + 30 天內到期）。
 * - urgent：期限在此天數內（含逾期）以橙色標示。
 */
export const REMINDER_DAYS = {
  default: 7,
  expanded: 30,
  urgent: 3,
} as const;

/** 首次登入自動建立的預設屬性名稱（依此順序即為初始 sortOrder）。 */
export const DEFAULT_CATEGORIES: readonly string[] = ['採購', '系統', '其他'];
