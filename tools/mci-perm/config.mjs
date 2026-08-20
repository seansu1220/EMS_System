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

/**
 * 保存的登入狀態。
 *
 * ⚠ 作法在 2026-08-18 換過一次：原本是把 cookie 存成 `state.json`，再灌進一個
 * 全新的瀏覽器（Playwright 每次啟動都是臨時 profile）。**實測完全沒用**——
 * 距離上次登入才 9 分鐘，這個 SSO 就判定要重新登入。對伺服器來說，
 * 每次都是一台從沒見過的機器：瀏覽器指紋、localStorage、sessionStorage 全是新的。
 *
 * 改成**固定的瀏覽器使用者資料夾**（persistent context）：等同「同一台電腦上的
 * 同一個 Chrome」，cookie 與各種儲存空間都留在磁碟上，下次直接接續。
 * 這是目前不繞過驗證碼的前提下，唯一能真正沿用登入的作法。
 */
export const SESSION_STATE = {
  /** 瀏覽器的使用者資料夾（等同登入憑證，已 gitignore、不打包進可攜版）。 */
  profileDir: path.join(PATHS.authDir, 'profile'),
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
   * 「帳號子系統權限」查詢頁的網址（2026-08-18 實跑取得）。
   *
   * ⚠ **只能用來認頁面，不能拿去直接開**：用 GET 開這個網址只會得到一個空白頁
   * （畫面上只有一個時間戳），而且導航過去之後連主畫面都回不去，
   * 反而把原本走得通的流程弄壞。這一頁只能從「你好 → 帳號子系統權限」進入。
   */
  permissionPagePath: '/SSO/subSystemSetForm',

  /**
   * 查詢結果的筆數文字（DataTables 樣式）：「顯示第 1 至 10 項結果，共 26 項」。
   *
   * 有這個就不必靠「數畫面上有幾個設定按鈕」——那會被分頁影響
   * （一頁只顯示 10 筆，實際可能更多），而「查到幾個人」正是決定
   * 「要不要動手」的關鍵判斷，寧可讀系統自己講的數字。
   */
  resultCountPattern: /共\s*([\d,]+)\s*項/,

  /** 結果還在載入時畫面上的字樣：看到它就代表數字還不能信。 */
  loadingMarkers: ['載入中', '處理中', 'Loading'],

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
    /**
     * 登入頁的縣市別下拉要選哪一個（使用者 2026-08-18 指定「桃園市」）。
     *
     * 這一欄沒有固定的 id 可用，因此改用**最可靠的特徵**來認：
     * 「選項裡有『桃園市』的那個下拉」——整頁不會有第二個下拉長這樣。
     * 要改縣市只要改 `.env` 的 `MCI_LOGIN_CITY`，不必動程式。
     */
    cityValue() {
      return (process.env.MCI_LOGIN_CITY ?? '桃園市').trim();
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
    /**
     * 查詢區三個欄位的 id（2026-08-18 實跑探測所得，`/SSO/subSystemSetForm`）。
     *
     * 這一頁**同時藏著「新增使用者」與「編輯使用者」兩整組表單**（`_txt*`、`edit_*`），
     * 欄位名稱一模一樣。靠標籤文字去猜很容易挑到隱藏的那一組，
     * 因此查詢區直接用 id 定位；下面的 `*Labels` 只在 id 失效（系統改版）時當後備。
     */
    querySelectors: {
      unit: '#searchDeptNotNfa',
      name: '#searchNameNotNfa',
      accountKeyword: '#searchAccountNotNfa',
    },
    /** 查詢條件：單位（下拉選單）。 */
    unitLabels: ['單位', '所屬單位', '機關', '單位名稱', '部門'],
    /** 查詢條件：姓名（文字欄）。 */
    nameLabels: ['姓名關鍵字', '姓名', '使用者姓名', '人員姓名'],
    /** 查詢條件：帳號關鍵字（必須清成空白，否則會查不到人）。 */
    accountKeywordLabels: ['帳號關鍵字', '帳號'],
    /** 查詢頁上回到主畫面的按鈕（查詢頁沒有「你好」選單，靠這顆回去）。 */
    backToMenuTexts: ['回到選擇系統', '回到選擇子系統'],
    /** 送出查詢的按鈕。 */
    searchTexts: ['搜尋', '查詢'],
    /** 查詢結果那一列的「設定」按鈕。 */
    rowActionTexts: ['設定'],
    /**
     * 要開通的子系統代碼（2026-08-18 探測所得）。
     *
     * 權限畫面每個子系統都是「一個勾選框 ＋ 一個角色下拉」，
     * id 就是代碼本身：`#MCI`（勾選框）與 `#MCIselect`（角色下拉）。
     *
     * ⚠ **一定要用 id，不能用「旁邊的文字」**：實跑發現這一頁的下拉與名稱
     * 在版面上是錯開的——`#ACSselect` 旁邊寫的是「MCI 大量傷病患救護管理系統」。
     * 用文字定位會挑到隔壁那個子系統（那才是真正會出事的錯誤）。
     */
    subsystemCode: 'MCI',
    /** 權限設定畫面裡那個子系統的顯示名稱（只用於訊息與後備定位）。 */
    subsystemText: 'MCI 大量傷病患救護管理系統',
    /** 子系統名稱的簡短比對字樣（全名有時會換排版或加空白）。 */
    subsystemHints: ['MCI大量傷病患', '大量傷病患救護管理'],
    /** 要選的角色（下拉選項，以包含比對）。 */
    roleText: 'MCI002 縣市端使用者',
    /** 角色的簡短比對字樣（系統可能寫成 `MCI002縣市端使用者`，中間沒空格）。 */
    roleHints: ['MCI002'],
    /**
     * 選好權限之後要按的送出鍵。
     *
     * **實測這一頁只有一顆，文字就是「確定」**（2026-08-20 確認）。
     * `finalConfirmTexts` 是留給「權限視窗之外還有一顆送出鍵」的版面用的後備，
     * 找不到就跳過，不影響結果。
     *
     * ⚠ 一律用**完全相符**比對：「確定」與「確認」只差一個字，
     *   用包含比對很容易按到不相干的按鈕。
     * ⚠ 有沒有真的存進去**不看按了幾顆**，一律以回讀查證為準（見 6.16）。
     */
    confirmTexts: ['確定'],
    finalConfirmTexts: ['確認', '儲存', '送出'],
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
  /**
   * 等一個畫面出現的上限。
   *
   * 政府系統換頁常常要好幾秒，原本只等 4 秒**不夠**（2026-08-18 實跑就卡在這裡）。
   */
  pageReadyTimeoutMs: 25 * 1000,
  /** 等畫面時每隔多久看一次。 */
  pollIntervalMs: 750,
  /**
   * 「共 N 項」要連續多久沒變才採信。
   *
   * 表格重新載入時這個數字會先掉成 0 再跳到正確值；只讀一次就會把
   * 「有這個人」判成「查無此人」（2026-08-20 實際發生過）。
   */
  countStableMs: 1200,
  /** 每處理完一位之間的間隔：不要打得比人快太多，避免被當成攻擊。 */
  betweenPeopleMs: 800,
  /** 單一步驟找不到東西時的重試次數與間隔。 */
  retryTimes: 3,
  retryIntervalMs: 1000,
};

/** 產出檔要保留幾天（結果清單含姓名，屬個資，不宜久放）。 */
export const RESULT_RETENTION_DAYS = 30;
