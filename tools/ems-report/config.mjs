/**
 * 救護紀錄表查詢工具 — 集中設定（配置驅動，調整行為只改這裡）。
 *
 * ⚠ 個資原則：本檔不得放置任何帳號密碼。帳密一律由 .env 提供（.env 已在 .gitignore）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 目標系統（桃園市政府消防局緊急救護管理系統）。 */
export const SITE = {
  /** 登入頁 / 全站共用的 servlet 進入點。 */
  entryUrl: 'https://emsdt.tyfd.gov.tw/EmmWeb/ActionControlServlet',
  /** 登入表單欄位 id（取自登入頁原始碼）。 */
  loginFields: {
    username: '#_txtUsername',
    password: '#_txtPassword',
    captcha: '#txtUserCode',
    submit: '#_btnOK',
  },

  /**
   * 登入後是 frameset 版面，各功能分屬不同 frame（名稱取自實際探測結果）。
   */
  frames: {
    /** 上方功能列（報表系統各功能的連結都在這裡）。 */
    header: 'header',
    /** 主要內容區（查詢條件、結果列表都在這裡）。 */
    content: 'contentFrame',
    /** 左側選單。 */
    sideMenu: 'contentSidemenu',
  },

  /** 選單項目文字（系統改字時只改這裡）。 */
  menu: {
    recordQuery: '救護紀錄表查詢',
  },

  /** 各功能的 AP 代號（取自選單連結）。 */
  apNames: {
    recordQuery: 'wap119.RPS64101030',
  },

  /**
   * 直接載入某個功能到內容框的網址樣板（點選單失敗時的備援）。
   * 格式取自實際的 contentFrame 網址。
   */
  contentUrl(apName) {
    const params = new URLSearchParams({
      id: '00',
      APname: apName,
      pushButton: 'load',
      pushFun: 'load',
      nextAPname: apName,
      _txtFirstEntry: 'TRUE',
    });
    return `https://emsdt.tyfd.gov.tw/EmmWeb/ActionControlServlet?${params}`;
  },

  /** 展開進階搜尋區塊的頁面函式名稱（按鈕的 onclick 就是呼叫這兩個）。 */
  advancedSearchToggles: ['triggleTable', 'triggleTable2'],

  /** 救護紀錄表查詢頁的欄位與按鈕（id 取自實際探測結果）。 */
  queryFields: {
    dateFrom: '#_txtFromDate',
    dateTo: '#_txtToDate',
    /** 救護狀態（未填寫/已填寫/未結案/已結案）。 */
    rescueStatus: '#_selSTATUS',
    /** 送醫情形（未運送/送醫）。 */
    transport: '#_selSPA11',
    /** 院前預警（未傳送預警/到院前傳送預警/到院後傳送預警）。 */
    prehospitalAlert: '#_selPreHOSPWarning',
    /** 分隊。 */
    squad: '#_selDeptnoCar',
    /** 查詢與匯出是圖片按鈕，不是標準表單按鈕。 */
    queryButton: '#_btnQuery',
    excelButton: '#_btnExcel',
  },

  /** 偵測不到系統日期元件設定時採用的格式（My97DatePicker 樣式）。 */
  defaultDateFormat: 'yyyy-MM-dd',

  /** 按下查詢後額外等待的緩衝時間（毫秒），讓伺服器把結果整理完。 */
  querySettleMs: 3000,
};

/** 等待匯出檔案開始下載的上限（毫秒）；資料量大時伺服器產檔會久一點。 */
export const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

/** 瀏覽器啟動設定。使用本機已安裝的 Chrome，不另外下載 Chromium。 */
export const BROWSER = {
  channel: 'chrome',
  /** 必須有頭：驗證碼要由使用者本人辨識輸入。 */
  headless: false,
  /** 放慢每個動作的毫秒數，方便肉眼確認流程有沒有跑歪。 */
  slowMo: 120,
  viewport: { width: 1440, height: 900 },
};

/**
 * 輸出路徑。整個 out/ 皆為 gitignore 範圍，且原始明細預設用完即刪。
 */
export const PATHS = {
  toolDir: TOOL_DIR,
  /** 所有產出的根目錄。 */
  outDir: path.join(TOOL_DIR, 'out'),
  /** 頁面結構探測結果（只存結構，不存資料列）。 */
  probeDir: path.join(TOOL_DIR, 'out', 'probe'),
  /** 系統匯出的原始 Excel（含個案明細，統計後刪除）。 */
  rawDir: path.join(TOOL_DIR, 'out', 'raw'),
  /** 最終彙總報表（只有分隊層級數字）。 */
  reportDir: path.join(TOOL_DIR, 'out', 'report'),
  /** 最近一次執行的完整紀錄（只有流程訊息，不含個案資料）。 */
  logFile: path.join(TOOL_DIR, 'out', 'last-run.log'),
};

/** 等待使用者手動登入的上限（毫秒）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** 登入後等待主畫面（frameset）建好的上限（毫秒）。 */
export const APP_READY_TIMEOUT_MS = 60 * 1000;

/**
 * 查詢條件的固定值。value 取自系統下拉選單的實際選項值，
 * label 僅供畫面顯示；日後系統若改動選項，只改這裡。
 */
export const QUERY_CRITERIA = {
  /** 救護狀態：兩次查詢都固定為「已結案」。 */
  rescueStatusValue: '0',
  rescueStatusLabel: '已結案',
  /**
   * 送醫情形：兩次查詢都固定為「送醫」。
   * 少了這個條件會把未運送案件（誤報、拒送、現場死亡等）一起算進母數，數字會偏高。
   */
  transportValue: '1',
  transportLabel: '送醫',
  /** 院前預警：第二次查詢（預警案件）才套用「到院前傳送預警」。 */
  prehospitalAlertValue: '1',
  prehospitalAlertLabel: '到院前傳送預警',
};

/**
 * 兩次匯出的定義。`alertValue` 為空字串代表院前預警不設條件（取全部）。
 */
export const DATASETS = {
  total: { key: 'total', label: '總案件數', alertValue: '' },
  alert: { key: 'alert', label: '到院前預警案件數', alertValue: QUERY_CRITERIA.prehospitalAlertValue },
};

/**
 * 匯出檔中「分隊」欄位可能的欄名，由前往後比對。
 * 系統改欄名時在這裡加一筆即可，不必動程式邏輯。
 */
export const SQUAD_COLUMN_CANDIDATES = [
  // 實測（2026-06 資料）匯出檔使用的就是「出勤單位」，放第一順位。
  // 注意：同一份檔案另有「分隊 自行受理」欄位，那是勾選記號（值為 V），不是分隊。
  '出勤單位',
  '分隊',
  '分隊名稱',
  '救護分隊',
  '出勤分隊',
  '隊別',
  '單位',
  '單位名稱',
];
