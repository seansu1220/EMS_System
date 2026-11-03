/**
 * 管理員給救護科電腦監看程式的請求（**只有管理員能按**，使用者 2026-11-03 指定）。
 * 對應 Firestore `unlockControl/{請求種類}`，每種只有一份文件：
 * - `revisionCheck`（v1.37）：立即比對——確認解鎖過的案件結案了沒、結案就比對
 * - `revisionReport`（v1.38）：匯出解鎖修改紀錄——在救護科電腦產出一段期間的 Excel
 *
 * 管理員按按鈕 → 寫入請求時間；監看程式下一輪看到比上次處理過的還新的請求就去做，
 * 並把進度與件數寫回來（本機那一端見 `tools/ems-report/unlockQueue.mjs`）。
 */

/** 本機監看回寫的處理狀態；還沒處理過任何請求為空字串。 */
export type ControlStatus = 'running' | 'done' | 'failed' | '';

/** 兩種請求共同的欄位（時間一律轉成 ISO 字串，沒有值為空字串）。 */
export interface ControlBase {
  /** 最近一次按下的時間。 */
  requestedAt: string;
  /** 最近一次按下的人。 */
  requestedByName: string;
  /** 監看程式最近認領的是哪一次請求（等於某次的 requestedAt）。 */
  handledRequestAt: string;
  status: ControlStatus;
  /** 開始處理的時間。 */
  startedAt: string;
  /** 處理完成的時間；還在處理為空字串。 */
  finishedAt: string;
}

/** 「立即比對」請求文件。 */
export interface RevisionCheckControl extends ControlBase {
  /** 這一輪確認了幾件解鎖過的案件；還沒做完為 null。 */
  checkedCount: number | null;
  /** 其中幾件已結案並比對完成；還沒做完為 null。 */
  comparedCount: number | null;
}

/** 「匯出解鎖修改紀錄」請求文件（報表含病患資料，只存在救護科電腦，這裡只有檔名與件數）。 */
export interface RevisionReportControl extends ControlBase {
  /** 要匯出的期間（依解鎖時間，起訖日都含），`YYYY-MM-DD`。 */
  rangeStart: string;
  rangeEnd: string;
  /** 產出的檔名（只含期間）；還沒做完為空字串。 */
  fileName: string;
  openCount: number | null;
  closedCount: number | null;
  /** 已結案而且有改動的件數。 */
  changedCount: number | null;
  /** 失敗時的說明（固定說法，不含病患資料）。 */
  errorMessage: string;
}

/** 日期區間（`YYYY-MM-DD`，起訖日都含）。 */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * 畫面上要顯示的階段：
 * - idle：從沒按過
 * - waiting：按了，監看程式還沒接手
 * - running：監看程式處理中
 * - done：最近一次已經做完
 * - failed：最近一次失敗（只有匯出會有）
 */
export type ControlPhase = 'idle' | 'waiting' | 'running' | 'done' | 'failed';
