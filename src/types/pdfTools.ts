/**
 * PDF 工具（v1.28 起為單一「工作區」：合併、拆分、整理、編輯在同一個頁面清單上完成）的資料結構。
 * 檔案全程只在瀏覽器記憶體內處理，這些型別都不會寫進 Firestore。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** 可加入工作區的檔案種類（圖片在加入時就轉成一頁 PDF）。 */
export type PdfFileKind = 'pdf' | 'jpg' | 'png';

/** 圖片轉成 PDF 頁面時的尺寸：放進 A4（置中縮放）或依圖片原尺寸。 */
export type ImagePageMode = 'a4' | 'original';

/** 拆分方式：依頁碼範圍（每個範圍一檔）／每 N 頁一檔／每頁一檔。 */
export type SplitMode = 'ranges' | 'every' | 'single';

/** 頁碼分組的結果（頁碼 1 起算）；不合法時附上給使用者看的說明。 */
export type PageGroupsResult = { ok: true; groups: number[][] } | { ok: false; error: string };

/** 輸出的一個檔案。 */
export interface OutputPdfFile {
  name: string;
  bytes: Uint8Array;
}

/** 頁面尺寸（pt）。 */
export interface PageSize {
  width: number;
  height: number;
}

// ---------- 標記（塗黑／馬賽克／螢光筆）----------

/** 標記種類：塗黑、馬賽克會讓該頁轉成圖片（底下文字真的消失）；螢光筆保留文字。 */
export type MarkKind = 'blackout' | 'mosaic' | 'highlight';

/** 目前選用的工具：瀏覽（只看、不畫）或三種標記之一。 */
export type EditTool = 'browse' | MarkKind;

/** 正規化矩形（0～1，左上角起算）。 */
export interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 頁面上的一個標記框。座標以「原頁面方向」（已套用 PDF 本身的旋轉、**不含**使用者在工作區加的旋轉）為準，
 * 所以使用者之後再轉頁面，標記會跟著轉。
 */
export interface PageMark extends NormRect {
  id: string;
  kind: MarkKind;
  /** 螢光筆顏色（CSS 色碼）；其他種類不使用。 */
  color?: string;
}

// ---------- 工作區 ----------

/** 加入工作區的一個來源檔（圖片已轉成一頁 PDF）。 */
export interface WorkSource {
  id: string;
  name: string;
  kind: PdfFileKind;
  /** PDF 位元組（圖片為轉換後的 PDF）。 */
  bytes: Uint8Array;
  pageCount: number;
  /** 各頁在原方向下的尺寸（pt）。 */
  pageSizes: PageSize[];
  /** 各頁 PDF 本身的旋轉角度（/Rotate）。 */
  baseRotations: number[];
  /** 縮圖與大圖用的 pdf.js 文件。 */
  preview: PDFDocumentProxy;
  /** 顏色編號（頁面清單上用來分辨是哪個檔案的頁）。 */
  colorIndex: number;
}

/** 工作區頁面清單中的一頁（清單順序＝輸出順序）。 */
export interface WorkPage {
  id: string;
  sourceId: string;
  /** 在來源檔中的頁索引（0 起算）。 */
  sourcePageIndex: number;
  /** 使用者額外加的旋轉（0／90／180／270，順時針）。 */
  rotation: number;
  marks: PageMark[];
}

/** 復原用的一步：當時的頁面清單與勾選（復原刪除時，回來的頁維持勾選）。 */
export interface WorkspaceSnapshot {
  pages: WorkPage[];
  selectedIds: string[];
}

/** 工作區狀態（頁面清單、目前看的頁、勾選的頁、可復原的歷史）。 */
export interface WorkspaceState {
  pages: WorkPage[];
  currentPageId: string | null;
  selectedIds: string[];
  /** 復原用：之前的狀態（最新的在最後）。 */
  history: WorkspaceSnapshot[];
}
