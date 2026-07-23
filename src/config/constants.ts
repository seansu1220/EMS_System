/**
 * 全域常數（配置驅動）。
 * 集中管理集合名稱、UI 色調、提醒天數、預設屬性，
 * 避免這些業務參數散落在各元件中出現魔術字串/數字。
 */

/** 應用程式名稱。 */
export const APP_NAME = '救護科業務管理系統';

/** 應用程式版本號（建置期由 vite 注入，取自 package.json）。 */
export const APP_VERSION = __APP_VERSION__;

/**
 * 建置時間（yyyy-MM-dd HH:mm，本地時區）。
 * 由建置期注入的 ISO 字串轉換，供 UI 顯示以確認是否載入到最新版本。
 */
export const APP_BUILD_TIME = (() => {
  const date = new Date(__BUILD_TIME__);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
})();

/** Firestore 集合名稱。 */
export const COLLECTIONS = {
  users: 'users',
  categories: 'categories',
  tasks: 'tasks',
} as const;

/** UI 色調鍵（對應 ui.tsx 的 Badge tone / 文字顏色樣式）。 */
export type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue';

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
