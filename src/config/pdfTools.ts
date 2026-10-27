/**
 * PDF 工具（/pdf-tools）的參數設定（配置驅動）。
 * 尺寸、上限、分頁標題集中於此，調整只改這裡。
 */

export const PDF_TOOLS_CONFIG = {
  /** 縮圖寬度（px，CSS 尺寸；實際繪製會再乘上裝置像素比）。 */
  thumbWidth: 140,
  /** 縮圖框的高寬比（直式 A4 約 1.414），旋轉成橫向時縮小以塞進同一個框。 */
  thumbBoxRatio: 1.414,
  /** 縮圖離畫面多遠就先畫（px），捲動時比較不會看到空白。 */
  thumbPreloadMargin: '300px',
  /** 超過這個大小提醒「處理可能較久」。 */
  largeFileWarnBytes: 100 * 1024 * 1024,
  /** A4 尺寸（pt，短邊 × 長邊）。 */
  a4Size: [595.28, 841.89] as const,
  /** 圖片放進 A4 時四周留白（pt）。 */
  imageMargin: 24,
  /** 拆分預告最多列出幾個檔名，其餘以「…」帶過。 */
  splitPreviewNameCount: 6,
} as const;

/** 選檔視窗的檔案類型篩選。 */
export const PDF_ACCEPT = '.pdf,application/pdf';
export const MERGE_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

/** 分頁定義（網址 #merge／#split／#organize 可直接開啟對應功能）。 */
export const PDF_TOOL_TABS = [
  { key: 'merge', icon: '📎', name: '合併', desc: '多個 PDF、圖片合成一份' },
  { key: 'split', icon: '✂️', name: '拆分', desc: '拆成多份或取出指定頁' },
  { key: 'organize', icon: '🗂️', name: '頁面整理', desc: '調整頁序、旋轉、刪除頁面' },
] as const;

export type PdfToolTabKey = (typeof PDF_TOOL_TABS)[number]['key'];
export const DEFAULT_PDF_TOOL_TAB: PdfToolTabKey = 'merge';
