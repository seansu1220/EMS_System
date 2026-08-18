/**
 * 「開通大量傷患系統權限」工具 — 集中設定（配置驅動，調整行為只改這裡）。
 *
 * ⚠ 個資原則：本檔不得放置任何帳號密碼。帳密一律由同目錄的 .env 提供（.env 已在 .gitignore）。
 *
 * ⚠ 這是**另一個系統**，與 tools/ems-report（緊急救護管理系統 emsdt.tyfd.gov.tw）
 *   網址不同、帳號不同、登入狀態也各存各的，兩邊完全不共用設定。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 檔案位置（全部落在本工具目錄底下，不與其他工具混用）。 */
export const PATHS = {
  toolDir: TOOL_DIR,
  outDir: path.join(TOOL_DIR, 'out'),
  logFile: path.join(TOOL_DIR, 'out', 'last-run.log'),
  /** 探測結果（只含欄位／按鈕／選項名稱，不含任何資料列內容）。 */
  probeDir: path.join(TOOL_DIR, 'out', 'probe'),
  /** 執行結果清單（成功／失敗逐筆）。 */
  resultDir: path.join(TOOL_DIR, 'out', 'result'),
  /** 登入狀態（等同憑證，已 gitignore）。 */
  authDir: path.join(TOOL_DIR, '.auth'),
};

/** 保存的登入狀態：短時間內再跑一次就不必重打驗證碼。 */
export const SESSION_STATE = {
  file: path.join(PATHS.authDir, 'state.json'),
  /** 超過這個時間就不沿用（伺服器端多半也早就逾時了）。 */
  maxAgeMs: 8 * 60 * 60 * 1000,
  /** 沿用時等主畫面就緒的上限：試探性質，等太久沒意義。 */
  reuseReadyTimeoutMs: 8000,
};

/**
 * 目標系統。
 *
 * ⚠ `entryUrl` 由 .env 的 `MCI_ENTRY_URL` 提供，不寫死在程式裡——
 *   這個系統的網址與救護系統不同，且日後可能換（測試站／正式站）。
 */
export const SITE = {
  /** @returns {string} 登入頁網址；未設定時丟出說明清楚的錯誤。 */
  entryUrl() {
    const url = (process.env.MCI_ENTRY_URL ?? '').trim();
    if (!url) {
      throw new Error(
        '還沒設定要進去哪個網站：請開啟 tools/mci-perm/.env，' +
          '把 MCI_ENTRY_URL= 後面填上該系統的登入頁網址（可從 .env.example 複製一份）',
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`MCI_ENTRY_URL 看起來不是網址（要以 http:// 或 https:// 開頭）：${url}`);
    }
    return url;
  },

  /**
   * 登入表單欄位。
   *
   * 這個系統的原始碼還沒探測過，因此**不寫死 id**，改用「特徵」來認：
   * 密碼欄一定是 `input[type=password]`，帳號欄是它前面的文字欄，
   * 驗證碼欄則靠 name/id/旁邊文字的關鍵字認出來。
   * 探測（`probe` 指令）跑過之後，可以把確定的 id 填進 `override` 來提高穩定度。
   */
  loginFields: {
    /** 驗證碼欄的識別關鍵字（比對 id、name 與旁邊的文字）。 */
    captchaHints: ['captcha', 'checkcode', 'validate', 'valicode', 'vcode', 'randcode', 'authcode', '驗證碼', '檢核碼'],
    /** 登入按鈕的文字／value 候選。 */
    submitTexts: ['登入', '登錄', '確定', 'Login', 'login', 'Sign in'],
    /** 探測後可在這裡填死選擇器（留空代表用上面的特徵自動認）。 */
    override: {
      username: '',
      password: '',
      captcha: '',
      submit: '',
    },
  },

  /**
   * 開通流程各步驟要點的東西（全部以「畫面上看得到的文字」定位）。
   *
   * 為什麼不用 id：這個系統的 id 尚未探測，且政府系統改版常換 id；
   * 而畫面文字是使用者操作時真正依據的東西，比 id 穩定也比較看得懂。
   */
  flow: {
    /** 右上角「OOO，你好」的使用者選單（只比對「你好」，前面是登入者姓名）。 */
    userMenuTexts: ['你好', '您好'],
    /** 使用者選單展開後要點的項目。 */
    accountMenuTexts: ['帳號子系統權限', '帳號子系統', '子系統權限'],
    /** 查詢條件：單位（下拉選單）。 */
    unitLabels: ['單位', '所屬單位', '機關', '單位名稱'],
    /** 查詢條件：姓名（文字欄）。 */
    nameLabels: ['姓名', '使用者姓名', '人員姓名'],
    /** 查詢條件：帳號關鍵字（必須清成空白，否則會查不到人）。 */
    accountKeywordLabels: ['帳號關鍵字', '帳號'],
    /** 送出查詢的按鈕。 */
    searchTexts: ['搜尋', '查詢'],
    /** 查詢結果那一列的「設定」按鈕。 */
    rowActionTexts: ['設定'],
    /** 權限設定畫面裡，要開通的那個子系統（以包含比對）。 */
    subsystemText: 'MCI大量傷病患救護管理系統',
    /** 子系統名稱的簡短比對字樣（全名有時會換排版或加空白）。 */
    subsystemHints: ['MCI大量傷病患', '大量傷病患救護管理'],
    /** 要選的角色（下拉選項或清單項目，以包含比對）。 */
    roleText: 'MCI002 縣市端使用者',
    /** 角色的簡短比對字樣（系統可能寫成 `MCI002縣市端使用者`，中間沒空格）。 */
    roleHints: ['MCI002'],
    /** 最後送出的確定按鈕。 */
    confirmTexts: ['確定', '確認', '儲存', '送出'],
  },

  /** 系統自身的錯誤字樣：出現就代表這一步已經失敗，不必再等。 */
  errorMarkers: ['Error!!!', '系統發生錯誤', '查無資料'],
};

/** 瀏覽器啟動設定。使用本機已安裝的 Chrome 或 Edge，不另外下載 Chromium。 */
export const BROWSER = {
  /** 公家電腦不一定裝了 Chrome，但幾乎必有 Edge（同為 Chromium 核心，操作方式相同）。 */
  channels: ['chrome', 'msedge'],
  /** 必須有頭：驗證碼要由使用者本人辨識輸入。 */
  headless: false,
  /** 放慢每個動作的毫秒數，方便肉眼確認流程有沒有跑歪。 */
  slowMo: 120,
  viewport: { width: 1440, height: 900 },
};

/** 等使用者本人完成登入的上限（含辨識驗證碼的時間）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** 登入後等主畫面出現的上限。 */
export const APP_READY_TIMEOUT_MS = 60 * 1000;

/** 各步驟的等待上限與緩衝。 */
export const TIMING = {
  /** 點擊後等畫面反應的上限。 */
  actionTimeoutMs: 20 * 1000,
  /** 送出查詢後額外等待的緩衝，讓伺服器把結果整理完。 */
  querySettleMs: 1500,
  /** 每處理完一位之間的間隔：不要打得比人快太多，避免被當成攻擊。 */
  betweenPeopleMs: 800,
  /** 單一步驟找不到東西時的重試次數與間隔。 */
  retryTimes: 3,
  retryIntervalMs: 1000,
};

/** 產出檔要保留幾天（結果清單含姓名，屬個資，不宜久放）。 */
export const RESULT_RETENTION_DAYS = 30;
