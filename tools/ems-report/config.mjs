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
};

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
};

/** 等待使用者手動登入的上限（毫秒）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 查詢條件的固定值。文字需與系統下拉選單顯示一致，日後系統改字只改這裡。
 */
export const QUERY_CRITERIA = {
  /** 救護狀態：兩次查詢都固定為此值。 */
  rescueStatus: '已結案',
  /** 院前預警：第二次查詢（預警案件）才套用。 */
  prehospitalAlert: '到院前傳送預警',
};

/** 兩次匯出的識別名稱，用於檔名與報表欄位。 */
export const DATASETS = {
  total: { key: 'total', label: '總案件數' },
  alert: { key: 'alert', label: '到院前預警案件數' },
};
