/**
 * 「立即比對」請求（v1.37 起，只有管理員能按）。
 * 對應 Firestore `unlockControl/revisionCheck`（全系統只有這一份文件）。
 *
 * 管理員在解鎖工單頁按「立即比對」→ 寫入請求時間；救護科電腦的監看程式
 * 下一輪看到比上次處理過的還新的請求，就去確認解鎖過的案件結案了沒、結案就比對，
 * 並把進度與筆數寫回來（本機那一端見 `tools/ems-report/unlockQueue.mjs`）。
 */

/** 本機監看回寫的處理狀態；還沒處理過任何請求為空字串。 */
export type RevisionCheckStatus = 'running' | 'done' | '';

/** 「立即比對」請求文件（時間一律轉成 ISO 字串，沒有值為空字串）。 */
export interface RevisionCheckControl {
  /** 最近一次按下的時間。 */
  requestedAt: string;
  /** 最近一次按下的人。 */
  requestedByName: string;
  /** 監看程式最近認領的是哪一次請求（等於某次的 requestedAt）。 */
  handledRequestAt: string;
  status: RevisionCheckStatus;
  /** 開始比對的時間。 */
  startedAt: string;
  /** 比對完成的時間；還在比對為空字串。 */
  finishedAt: string;
  /** 這一輪確認了幾件解鎖過的案件；還沒做完為 null。 */
  checkedCount: number | null;
  /** 其中幾件已結案並比對完成；還沒做完為 null。 */
  comparedCount: number | null;
}

/**
 * 畫面上要顯示的階段：
 * - idle：從沒按過
 * - waiting：按了，監看程式還沒接手
 * - running：監看程式比對中
 * - done：最近一次已經做完
 */
export type RevisionCheckPhase = 'idle' | 'waiting' | 'running' | 'done';
