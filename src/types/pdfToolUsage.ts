/**
 * PDF 工具使用紀錄（Firestore `pdfToolUsage/{autoId}`，v1.29 起）。
 * 每次開啟檔案（v1.30 起）、每按一次下載各記一筆，給管理員看「30 天內有誰用過」。
 * **刻意不記檔名**：救護紀錄的檔名常含姓名、TEMSIS，記下來就成了個資外流的管道。
 */

/** 動作：open＝把檔案加進工作區；其餘對應下載區的四個按鈕。 */
export type PdfUsageAction = 'open' | 'downloadAll' | 'downloadSelected' | 'perSource' | 'split';

/** 寫入時由畫面提供的內容（使用者與時間由服務層補上）。 */
export interface PdfUsageEntry {
  action: PdfUsageAction;
  /** 這次輸出的總頁數（open：這次加入的頁數）。 */
  pageCount: number;
  /** 這次產生幾個檔（拆分、各檔分開時大於 1；open：這次加入幾個檔）。 */
  fileCount: number;
  /** 清單上的頁來自幾個來源檔（大於 1 代表有合併）。 */
  sourceCount: number;
  /** 有塗黑／馬賽克／螢光筆的頁數。 */
  markedPages: number;
}

/** 讀出來的一筆紀錄。 */
export interface PdfToolUsage extends PdfUsageEntry {
  id: string;
  uid: string;
  userName: string;
  email: string;
  /** 使用時間（ISO 字串）。 */
  usedAt: string;
}
