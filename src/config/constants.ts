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
  checklistTemplates: 'checklistTemplates',
  holidays: 'holidays',
} as const;

/** UI 色調鍵（對應 ui.tsx 的 Badge tone / 文字顏色樣式）。 */
export type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue';

/**
 * 提醒天數門檻。
 * - default：預設提醒範圍（逾期 + 7 個日曆日內到期）。
 * - expanded：展開後的提醒範圍（逾期 + 30 個日曆日內到期）。
 * - urgent：剩餘「工作日」在此天數內（含逾期）以橙色標示。
 *
 * 註：default / expanded 為「納入提醒的視窗」，以日曆日計算（避免視窗被假日壓縮）；
 *     urgent 與畫面上顯示的剩餘天數一致，皆以工作日計算。
 */
export const REMINDER_DAYS = {
  default: 7,
  expanded: 30,
  urgent: 3,
} as const;

/**
 * 工作日的星期代碼（對應 Date.getDay()：0=週日、1=週一 … 6=週六）。
 * 這是「沒有假日資料時」的預設規則；國定假日與補班日由假日清單另行修正
 * （內建清單見 config/holidays.ts，計算見 lib/workday.ts）。
 */
export const WORKDAY_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** 首次登入自動建立的預設屬性名稱（依此順序即為初始 sortOrder）。 */
export const DEFAULT_CATEGORIES: readonly string[] = ['採購', '系統', '其他'];

/**
 * 管理員 email 白名單（不分大小寫）。
 * 管理員可核准/停用帳號、刪除業務；其餘已核准使用者僅可新增與編輯。
 * ⚠️ 修改時必須同步更新 `firebase/firestore.rules` 的 `isAdmin()`——
 * 規則無法引用本檔，權限的最終防線在資料庫層。
 */
export const ADMIN_EMAILS: readonly string[] = ['seansu1220@gmail.com'];

/** 帳號狀態的中文標籤與色調（配置驅動，供使用者管理頁顯示）。 */
export const USER_STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待審核', tone: 'amber' },
  approved: { label: '已核准', tone: 'green' },
  rejected: { label: '未通過', tone: 'red' },
};

/** 角色的中文標籤。 */
export const USER_ROLE_LABELS: Record<string, string> = {
  admin: '管理員',
  member: '一般使用者',
};
