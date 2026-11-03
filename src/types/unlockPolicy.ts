/**
 * 解鎖工單的「鎖定時段」設定（v1.32 起）。
 * 對應 Firestore `unlockPolicy/main`（全系統只有這一份文件）。
 *
 * 以**月份**為單位：鎖定到某個月，就代表那個月（含）以前的案件一律不受理解鎖申請。
 * 案件月份取自 TEMSIS 的前 6 碼（前 8 碼就是案發日期，本機工具實測 284 件全部吻合，
 * 見 `tools/ems-report/ekgAppeal.mjs` 的 `dateFromTemsis`）。
 *
 * 網頁（`unlockRequestService`）、安全規則（`firestore.rules` 的 `temsisInLockedPeriod`）
 * 與本機工具（`tools/ems-report/unlockQueue.mjs`）三處都依這份設定判斷，改格式要一起改。
 */

/** 月份字串，西元 `YYYY-MM`（例：`2026-09`＝民國 115 年 9 月）。 */
export type MonthKey = string;

/** 鎖定時段的設定。 */
export interface UnlockPolicy {
  /** 鎖定到哪個月（含）；null＝目前沒有鎖定任何時段。 */
  lockedThroughMonth: MonthKey | null;
  /** 最後修改時間（ISO 字串）；還沒有人改過（沿用預設值）為空字串。 */
  updatedAt: string;
  /** 最後修改者的顯示名稱；還沒有人改過為空字串。 */
  updatedByName: string;
  /** 是否為系統預設值（資料庫還沒有這份文件）。 */
  isDefault: boolean;
}
