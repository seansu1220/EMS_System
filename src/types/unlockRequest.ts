/**
 * 解鎖工單相關型別。
 * 對應 Firestore `unlockRequests/{id}` 文件。
 *
 * 這是「網頁提出申請 → 本機工具實際執行 → 結果回寫網頁」這條流程的資料契約，
 * 網頁端（React）與本機端（`tools/ems-report/`）都依照它讀寫，改欄位要兩邊一起改。
 *
 * ⚠ 為什麼實際解鎖不能在網頁做：目標系統每次登入都要**驗證碼**（本專案的鐵則是
 *   由本人辨識、不自動破解），瀏覽器也無法跨網域操作那套 frameset 系統。
 *   因此網頁只負責「申請與查結果」，真正動手的仍是本機工具。
 *
 * ⚠ 個資範圍：這裡只放 TEMSIS（案件編號）、事由、申請人與結果說明，
 *   **不放任何病患資料**。救護系統的帳密與登入狀態一律只留在本機。
 */

/**
 * 工單狀態。
 *
 * `pending`／`running` 是網頁這端的排隊狀態；其餘四種與本機工具的 `UnlockOutcome.status`
 * 一一對應（對照表在 `tools/ems-report/unlockQueue.mjs` 的 `toQueueStatus`）：
 * - `pending`：已送出，等本機工具來拿
 * - `running`：本機工具正在處理這一筆
 * - `unlocked`：已解鎖（對應「已解鎖」）
 * - `usageCleared`：紀錄表本來就沒有鎖頭，卡住的原因是**還被某台裝置線上使用中**，
 *   已把那筆佔用紀錄刪掉（對應「已解除佔用」）。這是第二種解鎖方式，
 *   刻意不與 `unlocked` 合併——對申請人來說結果一樣是「可以去改了」，
 *   但救護科實際動的是完全不同的地方，事後回頭核對要分得出來
 * - `noAction`：紀錄表沒有鎖頭，**而且也沒有人佔用**，這筆真的不需要動作（對應「無需處理」）
 * - `failed`：程式判斷不出來或流程出錯，要人接手（對應「需人工處理／查無案件／失敗」）
 * - `locked`：案件日期落在救護科**鎖定的時段**內，不予解鎖（v1.32 起）。
 *   送出時就會被擋下，這個狀態只會出現在「鎖定之前就已排隊」的工單上——
 *   由本機工具拿單時直接回寫，不會真的去動目標系統
 */
export type UnlockRequestStatus =
  | 'pending'
  | 'running'
  | 'unlocked'
  | 'usageCleared'
  | 'noAction'
  | 'failed'
  | 'locked';

/** 本機工具跑完之後回寫的結果。 */
export interface UnlockRequestResult {
  /** 案件日期時間，例如 `2026/07/12 10:38:41`；讀不到為 null。 */
  caseDate: string | null;
  /** 出勤車輛，例如 `大湳93`；讀不到為 null。 */
  vehicle: string | null;
  /** 派遣分隊；讀不到為 null。 */
  squad: string | null;
  /** 給人看的說明（成功的依據，或為什麼卡住）。 */
  detail: string;
  /** 處理完成時間（ISO 字串）。 */
  processedAt: string;
  /** 執行者的顯示名稱（是誰在電腦前跑的）。 */
  processedBy: string;
}

/**
 * 解鎖前備份 → 結案後比對的進度（v1.35 起，本機工具 v1.54.0）。
 *
 * - `waiting`：已備份解鎖前的紀錄表，等分隊改完、結案後比對
 * - `compared`：已比對，`items` 是改了哪些地方
 * - `superseded`：還沒等到結案就又被解鎖，改拿下一次的備份比對
 * - `expired`：解鎖後太久都沒結案，不再追
 * - `gaveUp`：比對一直失敗，要救護科自己到系統看
 */
export type UnlockRevisionState = 'waiting' | 'compared' | 'superseded' | 'expired' | 'gaveUp';

/**
 * 工單上的比對結果。
 *
 * ⚠ 個資：`items` 只寫**改了哪些欄位**（例如「更正「姓名」」「「到院時間」10:38 → 10:45」），
 *   姓名、身分證這類**只寫欄位名、不寫內容**（使用者 2026-11-03 指定）；
 *   完整的改前改後只存在救護科電腦的 `out/internal/`。
 */
export interface UnlockRequestRevision {
  /** 第幾版備份（系統上傳清單的檔案說明 `救護紀錄表內容-v{N}`）。 */
  version: number;
  /** 檔案說明原文，例如 `救護紀錄表內容-v1`。 */
  remark: string;
  state: UnlockRevisionState;
  /** 備份（＝解鎖）時間（ISO 字串）。 */
  backedUpAt: string;
  /** 最近一次去系統確認結案的時間；還沒確認過為 null。 */
  lastCheckedAt: string | null;
  /** 比對完成時間；還沒比對為 null。 */
  comparedAt: string | null;
  /** 幾處不同；還沒比對為 null。 */
  changeCount: number | null;
  /** 改了哪些地方（不含病患資料）。 */
  items: string[];
}

/** 解鎖工單。 */
export interface UnlockRequest {
  /** Firestore 文件 ID。 */
  id: string;
  /** 要解鎖的 TEMSIS 編號（一筆工單一個編號）。 */
  temsis: string;
  /** 申請事由（為什麼要解鎖）。 */
  reason: string;
  /** 申請人 uid。 */
  requestedBy: string;
  /** 申請人顯示名稱（存下來，看清單時不必再查 users）。 */
  requestedByName: string;
  /** 申請時間（ISO 字串）。 */
  requestedAt: string;
  /** 目前狀態。 */
  status: UnlockRequestStatus;
  /** 執行結果；尚未處理為 null。 */
  result: UnlockRequestResult | null;
  /** 解鎖前備份與結案後比對（v1.35）；沒有備份過為 null。 */
  revision: UnlockRequestRevision | null;
  /**
   * 是否不受鎖定時段限制（v1.33 起）。
   *
   * 管理員與救護科管理者送的工單、以及管理員「重新送單」的工單為 true：
   * 送出時不擋，本機工具拿單時也不會把它標成「時段已鎖定」。
   * 安全規則只准這兩種人設成 true，其他人送的一律為 false。
   */
  lockBypass: boolean;
}

/** 送出新工單時要填的內容。 */
export interface UnlockRequestInput {
  /** TEMSIS 編號（可一次貼多個，由呼叫端拆成多筆工單）。 */
  temsisList: string[];
  /** 申請事由（同一批共用）。 */
  reason: string;
}

/** 一筆落在鎖定時段內的 TEMSIS 編號（送出前的檢查結果）。 */
export interface TemsisLockedError {
  /** 使用者輸入的原始編號。 */
  temsis: string;
  /** 目前鎖定到哪個月（含），西元 `YYYY-MM`。 */
  lockedThroughMonth: string;
}

/** 一筆長度不對的 TEMSIS 編號（送出前的檢查結果）。 */
export interface TemsisLengthError {
  /** 使用者輸入的原始編號。 */
  temsis: string;
  /** 這個編號實際有幾個字元。 */
  length: number;
}
