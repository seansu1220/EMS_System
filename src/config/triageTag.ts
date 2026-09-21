/**
 * 測試用傷票（大量傷患檢傷追蹤卡）的設定值（配置驅動）。
 *
 * 號碼、每次上限、紙張與版面尺寸都集中在這裡；要改規則只改這一檔，
 * 繪圖（`lib/triageTagDraw.ts`）與發號（`services/triageTagService.ts`）都不必動。
 */

/**
 * 號碼格式：`H` + 2 碼 + `T` + 3 碼，範圍 `H00T000` ~ `H99T999`，共 10 萬張。
 *
 * 內部一律用「流水號」（0 ~ 99999）記帳，只在顯示與印製時才轉成字串，
 * 這樣接續發號只要做加法（見 `lib/triageTagNumber.ts`）。
 */
export const TRIAGE_TAG_NUMBER = {
  prefix: 'H',
  separator: 'T',
  /** `H` 後面的碼數（流水號的千位以上）。 */
  headDigits: 2,
  /** `T` 後面的碼數（流水號的後三碼）。 */
  tailDigits: 3,
} as const;

/** 流水號總數（`H00T000` ~ `H99T999`）。 */
export const TRIAGE_TAG_TOTAL = 10 ** (TRIAGE_TAG_NUMBER.headDigits + TRIAGE_TAG_NUMBER.tailDigits);

/**
 * 一次最多領幾張。
 * 純粹是防手殘（多打一個 0 就吃掉幾千個號碼，而且號碼發出去就收不回來），
 * 同時限制 PDF 大小——每張 A4 是一張 300dpi 的圖。
 * ⚠ 須與 `firebase/firestore.rules` 的 triageTagIssues 規則上限一致。
 */
export const TRIAGE_TAG_MAX_PER_REQUEST = 100;

/**
 * 印製版面（單位：公釐）。
 *
 * 一張 A4 直式左右並排兩張傷票；每張傷票放在 105 × 297 的格子裡，
 * 四周留白（影印機印不到紙邊），外框畫一圈淺灰虛線當裁切線。
 */
export const TRIAGE_TAG_LAYOUT = {
  pageWidthMm: 210,
  pageHeightMm: 297,
  /** 每張 A4 放幾張傷票（左右並排）。 */
  tagsPerSheet: 2,
  /** 傷票本身的寬高。 */
  tagWidthMm: 95,
  tagHeightMm: 285,
  /**
   * 輸出解析度。250dpi 印出來的字、條碼與 QR code 都清楚；
   * 再調高檔案會變很大（300dpi 每頁約 400KB，100 張傷票就是 100 頁 40MB）。
   */
  dpi: 250,
  /** 每頁存成 JPEG 的品質（0~1）。PNG 在 jsPDF 裡壓縮很慢，100 頁會卡住畫面。 */
  jpegQuality: 0.92,
} as const;

/** 四個檢傷分級色帶（由上而下），色碼取自紙本傷票。 */
export const TRIAGE_TAG_LEVELS: readonly { label: string; color: string }[] = [
  { label: '0', color: '#1a1a1a' },
  { label: 'I', color: '#ee5f6b' },
  { label: 'II', color: '#f3c14a' },
  { label: 'III', color: '#5cb85c' },
];

/** 傷票上用的字型（瀏覽器端繪圖，依序找得到哪個用哪個）。 */
export const TRIAGE_TAG_FONT_FAMILY =
  '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Heiti TC", sans-serif';
