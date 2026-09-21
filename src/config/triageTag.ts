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
 * 同一個單位每週最多領幾張（使用者 2026-09-21 指定）。
 * 「一週」是台灣時間**週一 00:00 ～ 週日 23:59**，每週一重新計算。
 * ⚠ 須與 `firebase/firestore.rules` 的 triageTagUnitWeeks 規則上限一致。
 */
export const TRIAGE_TAG_UNIT_WEEKLY_LIMIT = 20;

/**
 * 可以領傷票的單位：**只限月報表上的 41 個分隊**（使用者 2026-09-21 指定），畫面上用下拉選單選。
 *
 * 照抄 `tools/ems-report/config.mjs` 的 `BRIGADES`（月報表的大隊與分隊，官方慣用順序）。
 * 網頁建置不讀 tools 底下的檔案，所以這裡另存一份；**分隊調整時三個地方要一起改**：
 * 這裡、`tools/ems-report/config.mjs`、`firebase/firestore.rules` 的 triageUnitValid()。
 * 名單固定也順帶避免同一個分隊有不同寫法（「大湳」「大湳隊」）而被算成不同單位、繞過每週上限。
 */
export const TRIAGE_TAG_BRIGADES: readonly { name: string; squads: readonly string[] }[] = [
  {
    name: '第一大隊',
    squads: ['桃園分隊', '中路分隊', '大林分隊', '三民分隊', '大有分隊', '埔子分隊', '八德分隊', '大湳分隊', '茄苳分隊', '龜山分隊', '坪頂分隊', '迴龍分隊'],
  },
  {
    name: '第二大隊',
    squads: ['中壢分隊', '興國分隊', '華勛分隊', '內壢分隊', '龍岡分隊', '青埔分隊', '楊梅分隊', '幼獅分隊', '埔心分隊', '富岡分隊', '新屋分隊', '永安分隊'],
  },
  {
    name: '第三大隊',
    squads: ['蘆竹分隊', '山腳分隊', '大竹分隊', '大園分隊', '竹圍分隊', '觀音分隊', '新坡分隊', '草漯分隊'],
  },
  {
    name: '第四大隊',
    squads: ['圳頂分隊', '大溪分隊', '平鎮分隊', '復旦分隊', '山峰分隊', '龍潭分隊', '高平分隊', '復興分隊', '巴陵分隊'],
  },
];

/** 所有允許的單位（攤平）。 */
export const TRIAGE_TAG_UNITS: readonly string[] = TRIAGE_TAG_BRIGADES.flatMap((brigade) => brigade.squads);

/** 單位不在名單時給使用者看的說明。 */
export const TRIAGE_TAG_UNIT_HINT = '請從清單選擇分隊（只限月報表上的分隊）';

/**
 * 計算「第幾週」用的時區位移（台灣 UTC+8）。
 * 安全規則用伺服器時間算同一個數字，兩邊必須一致。
 */
export const TRIAGE_TAG_WEEK_UTC_OFFSET_HOURS = 8;

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
