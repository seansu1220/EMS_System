/**
 * PDF 工具（小工具頁的 PDF 工作區）的參數設定（配置驅動）。
 * 尺寸、上限、工具列定義集中於此，調整只改這裡。
 */

export const PDF_TOOLS_CONFIG = {
  /** 頁面清單縮圖寬度（px，CSS 尺寸；實際繪製會再乘上裝置像素比）。 */
  thumbWidth: 104,
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

/** 工作區的參數。 */
export const PDF_WORKSPACE_CONFIG = {
  /** 「復原上一步」最多記幾步。 */
  historyLimit: 50,
  /** 大圖最多佔視窗高度的比例。 */
  viewerMaxHeightRatio: 0.75,
  /** 大圖的繪製寬度（px，再乘裝置像素比，最多 2 倍）。 */
  viewerRenderWidth: 1000,
  /** 大圖最多快取幾張（切回剛看過的頁不用重畫）。 */
  viewerCacheSize: 8,
  /** 頁面清單上分辨來源檔的顏色（依加入順序輪流使用）。 */
  sourceColors: ['#2563eb', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0891b2'],
  /** 頁面來自多個檔案時，下載檔名的預設值（只有一個檔案時用「原檔名_已處理」）。 */
  defaultMergedName: '合併後的檔案',
} as const;

/**
 * pdf.js 讀檔資源的位置（由 vite.config.ts 複製到 public/pdfjs/）。
 * 中文字型對照表、標準字型、掃描檔影像解碼器、色彩描述檔；只有檔案用到時才會下載。
 */
export const PDFJS_RESOURCE_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

/** 選檔視窗的檔案類型篩選（PDF 與 JPG／PNG 圖片）。 */
export const WORKSPACE_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

/** 標記（塗黑／馬賽克／螢光筆）的參數。 */
export const PDF_EDIT_CONFIG = {
  /** 輸出時轉成圖片的倍率（1 = 72 dpi；2.5 ≈ 180 dpi，文字清楚、檔案不會太大）。 */
  exportScale: 2.5,
  /** 轉成圖片時長邊最多幾個像素（海報等超大頁面避免吃光記憶體）。 */
  maxExportSide: 5000,
  /** 轉成圖片的 JPEG 品質（0～1）。 */
  jpegQuality: 0.92,
  /**
   * 馬賽克格子大小＝頁面寬度 × 這個比例。
   * 刻意比一般內文字高還大，避免馬賽克後還能被軟體還原出文字。
   */
  mosaicBlockRatio: 1 / 45,
  /** 框選小於這個像素數視為誤點，不建立標記。 */
  minMarkPixels: 4,
  /** 螢光筆顏色（以「色彩增值」疊上，底下的字仍看得清楚）。 */
  highlightColors: [
    { name: '黃', value: '#fde047' },
    { name: '綠', value: '#86efac' },
    { name: '粉紅', value: '#f9a8d4' },
    { name: '藍', value: '#93c5fd' },
  ],
} as const;

/** 直式工具列的標記工具（順序即顯示順序）。 */
export const PDF_EDIT_TOOLS = [
  { key: 'browse', icon: '🖐', name: '瀏覽', hint: '只看、不畫' },
  { key: 'blackout', icon: '⬛', name: '塗黑', hint: '在大圖上拖曳框出要塗黑的範圍' },
  { key: 'mosaic', icon: '▦', name: '馬賽克', hint: '在大圖上拖曳框出要打馬賽克的範圍' },
  { key: 'highlight', icon: '🖍', name: '螢光筆', hint: '在大圖上拖曳框出要標示的文字' },
] as const;

/** 「不用印出來再掃描」的轉 PDF 小技巧（配置驅動，新增情境即加一筆）。 */
export const PDF_CONVERT_TIPS: readonly { title: string; steps: readonly string[] }[] = [
  {
    title: '電腦上的網頁、文件（Chrome、Edge）',
    steps: [
      '在要轉的畫面按 Ctrl＋P（或網頁上的「列印」按鈕）。',
      '「目的地」或「印表機」改選「另存為 PDF」（Edge 叫「儲存為 PDF」）。',
      '按「儲存」，選好位置就完成，不用真的印出來。',
    ],
  },
  {
    title: '電腦上的其他程式（Word、Excel、看圖軟體…）',
    steps: [
      '一樣按列印，印表機選「Microsoft Print to PDF」。',
      '按列印後會問你要存在哪裡、檔名叫什麼，存好就是 PDF。',
    ],
  },
  {
    title: 'iPhone（Safari）',
    steps: [
      '按下方的「分享」→「列印」。',
      '在列印選項畫面按右上角的「分享」圖示（較舊的 iOS 沒有這個圖示：改用兩指在預覽頁往外撥放大，再按分享）。',
      '選「儲存到檔案」就存成 PDF 了。',
    ],
  },
  {
    title: 'Android（Chrome）',
    steps: ['右上角 ⋮ →「分享」→「列印」。', '上方的印表機改選「儲存為 PDF」，再按 PDF 圖示存檔。'],
  },
  {
    title: '紙本文件（真的只有紙的時候）',
    steps: [
      'iPhone：「備忘錄」新增一則 → 相機圖示 →「掃描文件」，會自動裁切、拉正並存成 PDF。',
      'Android：「Google 雲端硬碟」右下角 ＋ →「掃描」，一樣直接產生 PDF。',
      '已經拍好的照片、截圖：直接加進上面的 PDF 工具，下載就是 PDF。',
    ],
  },
];
