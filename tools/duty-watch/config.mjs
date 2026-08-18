/**
 * 「值班監看」總管 — 集中設定。
 *
 * 這個工具**同時看顧兩個系統**：
 *   - 救護系統（`emsdt.tyfd.gov.tw`）：線上解鎖工單，有人申請就處理
 *   - 一站通（`nfaemsap3.nfa.gov.tw`）：大量傷患系統權限開通，貼名單就處理
 *
 * ⚠ 個資原則沿用兩邊各自的規範（見 TOOLS_SPEC 0.3）：帳密只在各自工具的 `.env`，
 *   本檔不放任何帳密；終端機與紀錄檔裡的姓名一律遮蔽。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
  toolDir: TOOL_DIR,
  outDir: path.join(TOOL_DIR, 'out'),
  /**
   * 即時紀錄（**邊跑邊寫**）。
   *
   * 常駐監看最常見的結束方式是「直接關掉視窗」，只在結束時落檔等於沒有紀錄
   * （救護系統那邊 2026-08-08 實際損失過一次）。這裡刻意用追加，跨多次執行的歷史都留著。
   */
  watchLog: path.join(TOOL_DIR, 'out', 'duty-watch.log'),
};

/**
 * 監看的節奏。
 *
 * 三個獨立的節拍，互不干擾：
 *   - `pollMs`：多久問一次雲端有沒有新的解鎖工單（只碰 Firestore，很輕）
 *   - `heartbeatMs`：多久戳一次**各自的**系統，讓登入不要因閒置而逾時
 *   - `statusEveryMs`：沒事發生時，多久在畫面上報一次「還活著」
 */
export const WATCH = {
  /** 多久跑一輪（查工單、收名單、看要不要心跳）。 */
  pollMs: 20 * 1000,

  /**
   * 多久戳一次系統維持登入。
   *
   * 取 5 分鐘：遠短於一般的閒置上限（多為 20~30 分鐘），又不會頻繁到像在洗頁面。
   * 救護系統實測這個節奏可以撐 6 小時 46 分（見 TOOLS_SPEC 5.3）。
   *
   * ⚠ 一站通能撐多久**還沒量過**。使用者 2026-08-18 要求「就算它 30 分鐘踢人，
   *   也要盡量維持」，因此兩邊用同一個節奏；掉線時各自停下來等本人重登，
   *   一邊掉線不會影響另一邊。
   */
  heartbeatMs: 5 * 60 * 1000,

  /** 沒事發生時，多久在畫面上報一次還活著。 */
  statusEveryMs: 30 * 60 * 1000,

  /**
   * 掉線之後，每一次「等使用者回來登入」要等多久。
   *
   * ⚠ 這**不是放棄的期限**：等不到只會跑下一輪、再等一次，監看永遠不會自己結束
   *   （救護系統那邊踩過：凌晨掉線時人在睡覺，舊版逾時就讓整個程式退出）。
   */
  reloginWaitMs: 5 * 60 * 1000,

  /** 掉線後，多久在畫面上再提醒一次「還在等你登入」。 */
  reloginRemindEveryMs: 30 * 60 * 1000,
};

/**
 * 貼名單的結束符號。
 *
 * 使用者貼完一批之後，**在空白行按一次 Enter** 就開始處理那一批。
 * 與一次性流程的手感一致（見 TOOLS_SPEC 0.7）。
 */
export const BATCH_END_LINE = '';
