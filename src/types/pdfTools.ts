/**
 * PDF 工具（合併／拆分／頁面整理）跨模組共用的資料結構。
 * 檔案全程只在瀏覽器記憶體內處理，這些型別都不會寫進 Firestore。
 */

/** 可處理的檔案種類（合併可混用 PDF 與圖片；拆分、整理只收 PDF）。 */
export type PdfFileKind = 'pdf' | 'jpg' | 'png';

/** 合併清單中的一個檔案。 */
export interface MergeItem {
  /** 清單內唯一鍵（拖曳排序用）。 */
  id: string;
  file: File;
  kind: PdfFileKind;
  bytes: Uint8Array;
  /** PDF 的頁數；圖片固定為 1。 */
  pageCount: number;
}

/** 圖片轉成 PDF 頁面時的尺寸：放進 A4（置中縮放）或依圖片原尺寸。 */
export type ImagePageMode = 'a4' | 'original';

/** 拆分方式：範圍各自成檔／擷取合成一檔／每 N 頁一檔／每頁一檔。 */
export type SplitMode = 'ranges' | 'extract' | 'every' | 'single';

/** 頁碼分組的結果（頁碼 1 起算）；不合法時附上給使用者看的說明。 */
export type PageGroupsResult = { ok: true; groups: number[][] } | { ok: false; error: string };

/** 頁面整理中的一頁：來源頁索引（0 起算）與額外旋轉角度（0／90／180／270）。 */
export interface OrganizedPage {
  sourceIndex: number;
  rotation: number;
}

/** 拆分產出的一個檔案。 */
export interface OutputPdfFile {
  name: string;
  bytes: Uint8Array;
}

// ---------- 編輯（塗黑／馬賽克／螢光筆）----------

/** 標記種類：塗黑、馬賽克會讓該頁轉成圖片（底下文字真的消失）；螢光筆保留文字。 */
export type MarkKind = 'blackout' | 'mosaic' | 'highlight';

/** 目前選用的工具：瀏覽（可捲動、不畫）或三種標記之一。 */
export type EditTool = 'browse' | MarkKind;

/**
 * 頁面上的一個標記框。座標以「畫面上看到的頁面」（已套用頁面本身的旋轉）為準，
 * 正規化成 0～1，與顯示尺寸、輸出解析度無關。
 */
export interface EditMark {
  id: string;
  /** 第幾頁（0 起算）。 */
  pageIndex: number;
  kind: MarkKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 螢光筆顏色（CSS 色碼）；其他種類不使用。 */
  color?: string;
}

/** 頁面在畫面上的尺寸（pt，已套用旋轉）。 */
export interface PageSize {
  width: number;
  height: number;
}
