/**
 * 測試用傷票相關型別。
 *
 * 對應兩個 Firestore 位置：
 * - `triageTagCounter/main`：全系統共用的「下一個流水號」，所有人的號碼從這裡接續往下發。
 * - `triageTagIssues/{起始流水號}`：每一次領取一筆紀錄（誰、幾張、從哪一號開始），
 *   文件 ID 就是起始流水號（不補零，例 `10`），天生不會重複。
 */

/** 發號計數器（`triageTagCounter/main`）。 */
export interface TriageTagCounter {
  /** 下一個要發出去的流水號（0 ~ 100000；100000 代表已經發完）。 */
  nextSerial: number;
}

/** 一次領取紀錄。 */
export interface TriageTagIssue {
  /** Firestore 文件 ID（起始流水號，例 `10`）。 */
  id: string;
  /** 起始流水號（0 起算；`H00T010` 就是 10）。 */
  startSerial: number;
  /** 這次領了幾張（號碼是從 startSerial 起連續的）。 */
  count: number;
  /** 領取人 uid。 */
  requestedBy: string;
  /** 領取人顯示名稱（存下來，看清單時不必再查 users）。 */
  requestedByName: string;
  /** 領取時間（ISO 字串）。 */
  requestedAt: string;
}
