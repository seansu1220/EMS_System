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
 * 後四種與本機工具的 `UnlockOutcome.status` 一一對應（見 `tools/ems-report/unlock.mjs`）：
 * - `pending`：已送出，等本機工具來拿
 * - `running`：本機工具正在處理這一筆
 * - `unlocked`：已解鎖（對應「已解鎖」）
 * - `noAction`：那張紀錄表本來就沒有鎖頭，不需要動作（對應「無需處理」）
 * - `failed`：程式判斷不出來或流程出錯，要人接手（對應「需人工處理／查無案件／失敗」）
 */
export type UnlockRequestStatus = 'pending' | 'running' | 'unlocked' | 'noAction' | 'failed';

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
