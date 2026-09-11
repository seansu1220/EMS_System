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
 */
export type UnlockRequestStatus =
  | 'pending'
  | 'running'
  | 'unlocked'
  | 'usageCleared'
  | 'noAction'
  | 'failed';

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
}

/** 送出新工單時要填的內容。 */
export interface UnlockRequestInput {
  /** TEMSIS 編號（可一次貼多個，由呼叫端拆成多筆工單）。 */
  temsisList: string[];
  /** 申請事由（同一批共用）。 */
  reason: string;
}

/** 一筆長度不對的 TEMSIS 編號（送出前的檢查結果）。 */
export interface TemsisLengthError {
  /** 使用者輸入的原始編號。 */
  temsis: string;
  /** 這個編號實際有幾個字元。 */
  length: number;
}
