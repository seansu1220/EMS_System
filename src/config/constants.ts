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
  /** 解鎖工單（網頁申請 → 本機工具執行 → 結果回寫）。 */
  unlockRequests: 'unlockRequests',
  /** 測試用傷票的發號計數器（只有一份文件 `main`）。 */
  triageTagCounter: 'triageTagCounter',
  /** 測試用傷票的領取紀錄（一次領取一筆，文件 ID＝起始流水號）。 */
  triageTagIssues: 'triageTagIssues',
  /** 測試用傷票的每週單位領取量（文件 ID＝`{週序}_{單位}`，每週上限見 config/triageTag）。 */
  triageTagUnitWeeks: 'triageTagUnitWeeks',
  /** PDF 工具使用紀錄（每次下載一筆，只有管理員讀得到，保留 30 天，見 config/pdfTools）。 */
  pdfToolUsage: 'pdfToolUsage',
  /** 解鎖工單的鎖定時段設定（只有一份文件 `main`，見 types/unlockPolicy）。 */
  unlockPolicy: 'unlockPolicy',
  /** 給本機監看的控制訊號（目前只有「立即比對」一份文件 `revisionCheck`，見 types/revisionCheck）。 */
  unlockControl: 'unlockControl',
} as const;

/**
 * 本機監看多久看一次雲端（秒），只用來在畫面上說「大約多久會開始」。
 * ⚠️ 須與 tools/ems-report/config.mjs 的 `UNLOCK.watch.pollMs` 一致。
 */
export const UNLOCK_WATCH_POLL_SECONDS = 20;

/** UI 色調鍵（對應 ui.tsx 的 Badge tone / 文字顏色樣式）。 */
export type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue';

/**
 * 提醒門檻，單位一律為「工作日」（扣掉週末與國定假日，見 lib/workday）。
 * - default：預設提醒範圍（逾期 + 剩餘 7 個工作日內到期）。
 * - expanded：展開後的提醒範圍（逾期 + 剩餘 30 個工作日內到期）。
 * - urgent：剩餘工作日在此天數內（含逾期）以橙色標示。
 *
 * 註：全站的剩餘天數（提醒視窗、畫面文字、急迫度色）都以工作日計算，
 *     避免同一個數字在不同地方代表不同的「天」。逾期天數例外，以日曆日呈現較直覺。
 */
export const REMINDER_WORKDAYS = {
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
  unlocker: '解鎖專用',
  emsManager: '救護科管理者',
};

/**
 * 管理員可以在使用者管理頁指派的角色。
 *
 * 不含 `admin`：管理員身分以 email 白名單認定（見 `ADMIN_EMAILS`），
 * 不是靠改文件得來的，列在這裡只會讓人以為改得動。
 */
export const ASSIGNABLE_ROLES: readonly { value: string; label: string; hint: string }[] = [
  { value: 'member', label: '一般使用者', hint: '可用業務管理與解鎖工單' },
  { value: 'emsManager', label: '救護科管理者', hint: '只能用解鎖工單、測試用傷票、小工具；看得到所有工單，可鎖定／解鎖時段' },
  { value: 'unlocker', label: '解鎖專用', hint: '只能提出解鎖工單，看不到業務資料' },
];

/**
 * 使用者管理頁上方的分頁（v1.36 起，使用者 2026-11-03 指定順序）。
 * 每個分頁對應一種帳號狀態；「停用」同時包含審核時就被拒絕的帳號（兩者狀態都是 rejected）。
 */
export const USER_TABS: readonly { status: 'approved' | 'rejected' | 'pending'; label: string; emptyText: string }[] = [
  { status: 'approved', label: '目前使用者', emptyText: '目前沒有已核准的使用者。' },
  { status: 'rejected', label: '停用', emptyText: '沒有停用的帳號。' },
  { status: 'pending', label: '待審核', emptyText: '目前沒有待審核的帳號。' },
];

/** 「目前使用者」分頁內依角色分組的顯示順序（權限高到低）。 */
export const USER_ROLE_GROUP_ORDER: readonly string[] = ['admin', 'emsManager', 'member', 'unlocker'];

/** 解鎖工單狀態的中文標籤與色調。 */
export const UNLOCK_STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待處理', tone: 'amber' },
  running: { label: '處理中', tone: 'blue' },
  unlocked: { label: '已解鎖', tone: 'green' },
  // 第二種解鎖方式的結果（v1.20）：案件本來就是未結案，卡住的原因是那份紀錄表
  // **還被某台裝置佔用著**，救護科把那筆佔用紀錄刪掉就放開了。
  // 對申請人來說結果一樣是「可以去改了」，但分開列才看得出救護科實際動了什麼。
  usageCleared: { label: '已解除佔用', tone: 'green' },
  // 「案件未結案」是**申請人聽得懂的說法**：沒有鎖頭＝這件本來就還沒結案，
  // 直接進去改就好。本機工具的終端機仍講「本來就沒鎖」，那是給操作的人看的。
  noAction: { label: '案件未結案', tone: 'slate' },
  failed: { label: '需人工處理', tone: 'red' },
  // 鎖定時段（v1.32）：送出時就會被擋，只有「鎖定前就已排隊」的工單會由本機工具標成這個狀態。
  locked: { label: '時段已鎖定', tone: 'slate' },
};

/**
 * 結果欄給**申請人**看的一句話。
 *
 * 本機工具回寫的 `result.detail` 是寫給維護的人看的（第幾張紀錄表、比對到哪個按鈕、
 * 畫面出現什麼訊息…），對分隊來說只是雜訊。申請人要知道的只有「這筆到底怎麼了、
 * 我現在能不能去改」，所以清單上只給這一句；真要追過程請看執行電腦的
 * `tools/ems-report/out/watch.log`（使用者 2026-08-09 指定）。
 *
 * 管理員另外看得到完整的 `detail`（見 `UnlockPage` 的 `ResultCell`）。
 */
export const UNLOCK_RESULT_SUMMARY: Record<string, string> = {
  pending: '等救護科電腦執行',
  running: '正在處理…',
  unlocked: '已解鎖，可以進系統修改了',
  // 講「有人還開著」而不是「佔用紀錄」：申請人不需要知道系統內部怎麼記這件事，
  // 只需要知道原因不是自己填錯、而且現在可以去改了。
  usageCleared: '本來就是未結案，但還有人開著；已經幫你放開，可以進系統修改了',
  noAction: '案件未結案，不需解鎖。有問題請洽救護科承辦人',
  failed: '請洽救護科承辦人處理',
  locked: '該時段已經被鎖，請洽救護科人員',
};

/**
 * 解鎖前備份 → 結案後比對的狀態說明（v1.35，對應 `UnlockRevisionState`）。
 * 救護科（看得到所有工單的人）在結果欄看到的那一行。
 */
export const UNLOCK_REVISION_LABELS: Record<string, { label: string; tone: Tone }> = {
  waiting: { label: '已備份原紀錄表，等結案後比對', tone: 'blue' },
  compared: { label: '結案後比對完成', tone: 'green' },
  superseded: { label: '結案前又解鎖一次，改用下一次的備份比對', tone: 'slate' },
  expired: { label: '解鎖後太久沒結案，不再比對', tone: 'slate' },
  gaveUp: { label: '比對一直失敗，請自行到系統核對', tone: 'red' },
};

/**
 * 已備份、而且救護科電腦**確認過還沒結案**時顯示的那一行（使用者 2026-11-03 要求顯示「案件未結案」）。
 * 還沒確認過（剛解鎖）時用 `UNLOCK_REVISION_LABELS.waiting`。
 */
export const UNLOCK_REVISION_NOT_CLOSED = { label: '案件未結案', tone: 'amber' as Tone };

/**
 * 一次最多能送出幾筆解鎖工單。
 * 純粹是防手殘（例如整欄幾百個編號誤貼進來），不是系統限制。
 */
export const UNLOCK_REQUEST_MAX_BATCH = 50;

/**
 * 一組 TEMSIS 編號的固定長度（純數字 22 碼，例：`2026090710100307554102`）。
 *
 * 分隊常見的錯誤是抄少一碼或多貼一碼，送進來只會在本機工具那端查無案件，
 * 白等一輪；所以在網頁送出前就用長度擋掉（使用者 2026-09-07 指定）。
 */
export const TEMSIS_CODE_LENGTH = 22;

/**
 * 還沒有人設定過鎖定時段時（資料庫沒有 `unlockPolicy/main`）的預設值：
 * 民國 115 年 9 月（含）以前的救護紀錄表一律不受理解鎖（使用者 2026-11-03 指定）。
 *
 * ⚠️ 須與 `firebase/firestore.rules` 的 `lockedThroughMonth()`、
 * `tools/ems-report/config.mjs` 的 `UNLOCK.lock.defaultThroughMonth` 一致。
 * 救護科管理者在解鎖工單頁存過一次之後，就以資料庫裡的值為準，這個預設值不再有作用。
 */
export const UNLOCK_LOCK_DEFAULT_THROUGH_MONTH = '2026-09';

/** 鎖定時段的月份選單從民國幾年開始列（太早的年份不會有人要申請解鎖）。 */
export const UNLOCK_LOCK_FIRST_ROC_YEAR = 110;

/** 民國年＝西元年減去這個數。 */
export const ROC_YEAR_OFFSET = 1911;
