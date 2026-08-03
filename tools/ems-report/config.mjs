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

  /**
   * 系統自身錯誤訊息的開頭字樣，例如
   * `Error!!! wap119.RPS64101030_1._btnExcel()`（伺服器端執行匯出時拋出例外）。
   * 出現這個字樣代表動作已失敗，不必再等下載。
   */
  errorMarker: 'Error!!!',

  /** 按下查詢後額外等待的緩衝時間（毫秒），讓伺服器把結果整理完。 */
  querySettleMs: 3000,
};

/** 等待匯出檔案開始下載的上限（毫秒）；資料量大時伺服器產檔會久一點。 */
export const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

/** 瀏覽器啟動設定。使用本機已安裝的 Chrome，不另外下載 Chromium。 */
export const BROWSER = {
  /**
   * 依序嘗試的瀏覽器：公家電腦不一定裝了 Chrome，但幾乎必有 Edge
   * （兩者同為 Chromium 核心，Playwright 的操作方式完全相同）。
   */
  channels: ['chrome', 'msedge'],
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

/**
 * 登入狀態（cookie）的保存設定。
 *
 * 為什麼要存：驗證碼一律由使用者本人辨識（見 `session.mjs` 檔頭的設計取捨），
 * 一天要跑好幾輪時等於每輪都得重打一次。把「本人登入成功之後」的工作階段留下來，
 * 下一輪直接帶著，系統看到已經登入就不會再出現登入頁。
 *
 * ⚠ 這**不是繞過驗證碼**：驗證碼仍然由使用者本人解過一次，
 * 這裡只是沿用自己解出來的登入結果，等同瀏覽器的「保持登入」。
 */
export const SESSION_STATE = {
  /**
   * cookie 檔位置。
   * 內容等同登入憑證，因此：已列入 .gitignore、可攜版也不會複製（只複製 *.mjs）。
   */
  file: path.join(TOOL_DIR, '.auth', 'state.json'),
  /**
   * 超過這個時間就不再沿用，直接重新登入（毫秒）。
   *
   * 伺服器通常會更早讓 session 過期（過期會自動退回登入頁，程式會自己改走正常登入），
   * 這裡設上限只是為了不讓登入憑證無限期留在磁碟上。
   */
  maxAgeMs: 8 * 60 * 60 * 1000,
  /**
   * 沿用登入狀態時，等待主畫面出現的上限（毫秒）。
   *
   * 刻意比 `APP_READY_TIMEOUT_MS` 短很多：這裡是在「試探」舊 session 還有沒有效，
   * 失敗只是退回正常登入，不值得先空等一分鐘。
   */
  reuseReadyTimeoutMs: 15 * 1000,
};

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
 * 大隊與轄下分隊。
 *
 * 順序取自使用者提供的既有報表（`6月份到院前預警比例.xlsx`），即官方慣用排列，
 * 報表輸出時會照這個順序呈現。分隊調整或改隸時只需改這裡。
 */
export const BRIGADES = [
  {
    name: '第一大隊',
    squads: ['桃園分隊', '中路分隊', '大林分隊', '三民分隊', '大有分隊', '埔子分隊',
      '八德分隊', '大湳分隊', '茄苳分隊', '龜山分隊', '坪頂分隊', '迴龍分隊'],
  },
  {
    name: '第二大隊',
    squads: ['中壢分隊', '興國分隊', '華勛分隊', '內壢分隊', '龍岡分隊', '青埔分隊',
      '楊梅分隊', '幼獅分隊', '埔心分隊', '富岡分隊', '新屋分隊', '永安分隊'],
  },
  {
    name: '第三大隊',
    squads: ['蘆竹分隊', '山腳分隊', '大竹分隊', '大園分隊', '竹圍分隊', '觀音分隊',
      '新坡分隊', '草漯分隊'],
  },
  {
    name: '第四大隊',
    squads: ['圳頂分隊', '大溪分隊', '平鎮分隊', '復旦分隊', '山峰分隊', '龍潭分隊',
      '高平分隊', '復興分隊', '巴陵分隊'],
  },
];

/**
 * 報表的**內容**設定（每種報表各一份）。
 *
 * 視覺樣式（字級、框線、大隊列底色…）全部共用 {@link REPORT_FORMAT}，
 * 這裡只放「這份報表叫什麼、欄位怎麼命名」——兩份報表長得一模一樣，
 * 差別僅在標題與欄名，分成兩層才不會為了改一個欄名而複製整套樣式。
 */
export const REPORT_PROFILES = {
  /** 到院前預警比率（第 1 章）。欄名與分頁名稱比照使用者既有的人工報表。 */
  alert: {
    key: 'alert',
    /** 輸出檔名前綴，實際檔名為 `{prefix}-{YYYY-MM}.xlsx`。 */
    fileNamePrefix: '到院前預警比率',
    /** 分頁名稱：第一頁為大隊＋轄下分隊，第二頁為各分隊依比率排序。 */
    sheets: { grouped: '到院前預警比例', sorted: '排序' },
    /** 欄位標題（第一欄留白，比照既有報表）。 */
    columns: ['', '有送醫有預警案件', '有送醫案件', '到院前預警率'],
    /** 欄寬下限；實際寬度會依內容自動加寬，確保文字不被截掉。 */
    columnWidths: [16, 18, 14, 14],
    /** 第一列標題的後半段，前面會自動接上「本局{起}-{迄}」。 */
    titleSuffix: '到院前預警案件執行率',
    /** 終端機第二張表的抬頭。 */
    sortedHeading: '各分隊（依到院前預警率由高到低）',
  },

  /**
   * 12 導程心電圖的到院前傳輸率（第 3 章）。
   *
   * 分母＝期間內做過 EKG 檢查的案件；
   * 分子＝期間內做了 12 導程心電圖，**且經逐案查核確認在到院前就傳出去**的案件。
   */
  ekg: {
    key: 'ekg',
    fileNamePrefix: '心電圖到院前傳輸率',
    sheets: { grouped: '心電圖到院前傳輸比例', sorted: '排序' },
    columns: ['', '到院前傳出12導程案件', 'EKG檢查案件', '到院前傳輸率'],
    columnWidths: [16, 24, 16, 14],
    titleSuffix: '12導程心電圖到院前傳輸率',
    sortedHeading: '各分隊（依到院前傳輸率由高到低）',
  },
};

/**
 * 報表輸出的**共用樣式**（兩份報表完全相同，改這裡兩份一起變）。
 */
export const REPORT_FORMAT = {
  /** 比率欄的 Excel 數值格式。 */
  ratioNumberFormat: '0.00%',

  /** 字級：內文一律 12，第一列標題 16。 */
  fontSize: 12,
  titleFontSize: 16,
  /**
   * 列高。單位是點（pt），需明顯大於字級才不會顯得擁擠：
   * 12pt 的字理論上 18 就夠放，但實際看起來很擠，故取約字級的兩倍留出上下空白。
   */
  titleRowHeight: 32,
  rowHeight: 24,
  /** 框線樣式（Excel 的一般粗細）。 */
  borderStyle: 'thin',
  /** 所有儲存格對齊方式。 */
  alignment: { horizontal: 'center', vertical: 'middle' },

  /**
   * 大隊列的樣式（要改顏色就改這裡，色碼為 ARGB，前兩碼是透明度固定 FF）。
   * 預設為淺紅底＋深紅粗體字：底色夠明顯可一眼區分大隊與分隊，
   * 又不會像純紅底那樣把黑字壓到看不清楚。
   */
  brigadeRowStyle: {
    fillArgb: 'FFFFC7CE',
    fontArgb: 'FF9C0006',
    bold: true,
  },
  /** 欄位標題列的樣式。 */
  headerRowStyle: { bold: true },
  /** 匯出檔中出現、但不在 BRIGADES 內的單位，歸到這一組並提醒使用者。 */
  unmappedGroupName: '未對應大隊',
};

/**
 * 解鎖救護紀錄表（把已結案的案件調整為未結案）的設定。
 *
 * 這個流程走的畫面比統計流程多，且**元件 id 未經探測確認**，
 * 因此一律以「畫面上看得到的文字」定位（見 `pageFinder.mjs`）：
 * 系統改版換 id 不影響，只有改字時才需要動這裡。
 */
export const UNLOCK = {
  /** 查詢期間：今天往回推幾個月（使用者指定「近兩個月」）。 */
  lookbackMonths: 2,

  /** 案件列表功能在左側選單的文字。 */
  caseListMenuText: '案件列表',

  /**
   * 各欄位的標籤文字候選（由前往後比對，比對時忽略空白與全半形差異）。
   * 命中第一個就停，因此把最精確的放前面。
   */
  fieldLabels: {
    /** 救護紀錄表查詢頁的 TEMSIS 編號欄（實測標籤為「TEMSIS ID」，欄位 `#_txtTEMSISID`）。 */
    temsis: ['TEMSIS ID', 'TEMSIS編號', 'TEMSIS'],
    /** 案件列表頁的派遣案號欄。 */
    dispatchNo: ['派遣案號', '指派案號', '案號'],
  },

  /**
   * 按鈕／連結的文字候選。
   * 「救護紀錄PDF(桃)」要排在「救護紀錄PDF」前面，否則會被前者的子字串比對搶先命中。
   */
  buttonTexts: {
    /** 查詢結果列上開啟救護紀錄表的按鈕。 */
    openRecordSheet: ['救護紀錄PDF(桃)', '救護紀錄PDF'],
    /**
     * 案件列表上進入案件內部的連結。
     * 比對時用**完全相等**，否則會連「救護紀錄PDF」一起命中。
     */
    openCase: ['救護紀錄'],
    /**
     * 案件內部用來點開某一張紀錄表的連結。
     *
     * 實測是「**救護紀錄(鎖)**」（已結案的紀錄表帶鎖頭），與案件列表上的文字不同，
     * 故兩者分開設定。這裡用**包含**比對，`(鎖)` 換成別的字樣也還接得住。
     * 同一頁沒有其他含「救護紀錄」的元素（另有「新增紀錄表」不會誤中）。
     */
    openRecordInCase: ['救護紀錄(鎖)', '救護紀錄'],
    /**
     * 「這張紀錄表是鎖住的」的特徵字。
     *
     * 實測（2026-08-02）：同一件案子的 4 張紀錄表，按鈕文字有兩種——
     * 已結案的是「救護紀錄(鎖)」，**未結案的是「救護紀錄」（沒有鎖頭）**。
     * 沒有鎖頭那張按下去不會開 PDF，而是把畫面帶進紀錄表編輯頁
     * （該頁可點的是：新增｜修改｜儲存｜匯出Pdf…），因此也讀不到內容。
     *
     * 它既然已經是未結案，就**不可能是解鎖目標**，逐張比對時直接略過。
     * 只比對「鎖」字而不比對整個 `(鎖)`，是為了不被全形／半形括號的差異絆倒。
     */
    lockedRecordMarker: '鎖',
    /** 案件內部把案件解鎖的按鈕。 */
    unlock: ['調整為未結案'],
  },

  /**
   * 救護紀錄表上要抓的欄位標籤。
   * 抓法：找到標籤文字後，取其後方最近的一段值（見 `sheetFields.mjs`）。
   *
   * 前兩個是流程必需；後兩個純粹是**留給使用者事後追查用的紀錄**
   * （使用者 2026-07-31 指定：解鎖時要能看出是哪一天、哪一台車的案件），
   * 抓不到不影響解鎖，只會在紀錄裡標示讀不到。
   */
  sheetLabels: {
    dispatchNo: ['救災救護指揮中心指派案號', '指揮中心指派案號', '指派案號'],
    temsis: ['TEMSIS'],
    /**
     * 案件日期。實測會命中「日期」而取到 `07-02 07:32`（月-日 時:分），
     * 已足夠回答「這是幾月幾號的案件」；把較精確的寫法排在前面優先試。
     */
    caseDate: ['受理時間', '受理', '出勤時間', '出動時間', '發生時間', '案件日期', '日期'],
    /**
     * 出勤車輛。紀錄表上的欄位實際叫「**出勤單位**」，值像「桃園91」「楊梅95」
     * （使用者 2026-07-31 告知）。與統計流程匯出檔的分隊欄同名，屬同一套用語。
     */
    vehicle: ['出勤單位', '出勤車輛', '救護車號', '車號', '車輛'],
  },

  /**
   * 救護紀錄表查詢頁「查詢結果那一列」要讀的欄位（供事後追查用）。
   *
   * 為什麼不從 PDF 讀：PDF 的文字順序是「標題1 標題2 … 值1 值2 …」，
   * 抓標籤後面的字會抓到**下一個標題**而不是值（實測「出勤單位」抓到「受案單位」）。
   * 查詢結果是 HTML 表格，有標題列可以對照，可靠得多。
   */
  listColumns: {
    /** 案件日期。實測查詢結果有這一欄，值像 `2026/07/02 12:44:08`。 */
    caseDate: ['受理時間', '受理日期', '案件時間', '日期'],
  },

  /**
   * **案件內部**那張表格的欄位（探測到的標題列：
   * 項次／日期／派遣車輛／梯次／派遣分隊／救護表狀態／…）。
   *
   * 這裡是取得「出勤車輛」的正確地方：一列就是一張紀錄表，
   * 因此讀到的正是**要解鎖的那一張**所屬的車輛與分隊，而不是整件案子的。
   */
  caseColumns: {
    vehicle: ['派遣車輛', '出勤車輛', '車輛'],
    squad: ['派遣分隊', '出勤單位', '分隊'],
  },

  /**
   * 判斷「已經進入案件內部」的特徵字串（出現任一個就算到了）。
   *
   * 為什麼需要：點完「救護紀錄」後若只固定等幾秒就往下做，頁面還沒切換完成時
   * 會誤以為停在案件列表的畫面就是案件內部，於是回報「找不到解鎖按鈕」（實際踩過）。
   */
  caseDetailMarkers: ['派遣車輛', '救護表狀態', '調整為未結案'],

  /** 等待進入案件內部的上限（毫秒）。 */
  caseDetailTimeoutMs: 20 * 1000,

  /** 開啟救護紀錄表後，等待內容（PDF 或網頁）就緒的上限（毫秒）。 */
  sheetTimeoutMs: 60 * 1000,

  /**
   * 按下開啟紀錄表之後，隔多久才開始檢查「原本的畫面是不是被導走了」（毫秒）。
   *
   * 太短會把「頁面還沒開始反應」誤判成被導走；夠長則能在畫面確實被換掉時
   * 立刻收手，不必空等 `sheetTimeoutMs` 那一整分鐘。
   */
  abortCheckDelayMs: 3 * 1000,

  /** 每次查詢後的緩衝時間（毫秒）。 */
  settleMs: 2500,
};

/**
 * 12 導程心電圖到院前傳輸率（第 3 章）的設定。
 *
 * 這個流程走的欄位（EKG檢查勾選框、心電圖下拉）與畫面（傳輸紀錄、上傳）
 * **都沒有經過探測**，因此一律以「畫面上看得到的文字」定位（見 `pageFinder.mjs`）。
 * 系統改版換 id 不影響，只有改字時才需要動這裡。
 */
export const EKG = {
  /**
   * 分母查詢：「急救處置進階搜尋」區塊裡的 EKG 檢查勾選框。
   *
   * 以**勾選框旁邊的文字**定位。候選由前往後試，把最精確的放前面
   * （只寫 `EKG` 會連「EKG判讀」之類的欄位一起命中）。
   */
  procedureLabels: ['EKG檢查', 'EKG 檢查', 'EKG檢查(12導程)', 'EKG'],

  /**
   * 分子查詢：「心電圖」下拉選單中代表 12 導程的選項。
   *
   * 刻意用**選項文字**反推是哪一個下拉，而不是找標籤：
   * 一頁上有 22 個以上的下拉，但「12導程心電圖」這個選項只會出現在心電圖那一個，
   * 這樣定位比找標籤精確，也不怕系統把標籤從「心電圖」改成「心電圖類型」。
   */
  twelveLeadOptionTexts: ['12導程心電圖', '１２導程心電圖', '12導程', '十二導程'],

  /**
   * 分子查詢要不要**同時**勾著「EKG檢查」。
   *
   * 預設 false，即照使用者描述的操作：分母查 EKG檢查、分子只用心電圖下拉，兩次條件互不干擾。
   * 12 導程本來就是 EKG 的一種，理論上勾不勾結果相同；真的不同就代表兩個欄位語意不一樣，
   * 屆時把這裡改成 true 即可，不必動程式。
   */
  keepProcedureCheckedForNumerator: false,

  /** 逐案查核（判斷 12 導程是不是在到院前就傳出去了）。 */
  verify: {
    /**
     * 匯出檔中「TEMSIS」欄的欄名候選。
     * 逐案查核要靠 TEMSIS 一件一件查回系統，找不到這一欄就無法查核。
     */
    temsisColumns: ['TEMSISID', 'TEMSIS ID', 'TEMSIS', 'TEMSIS編號'],

    /**
     * 「到院時間」的欄名／標籤候選。
     * 三個地方都用這一組：匯出檔的欄、查詢結果那一列的欄、救護紀錄表 PDF 上的標籤。
     */
    arrivalLabels: ['到院時間', '到達醫院時間', '抵達醫院時間', '送達醫院時間', '到院'],

    /**
     * 「傳輸紀錄」按鈕的文字候選。
     *
     * 使用者描述它在「案件列表那邊」，但沒說是查詢結果那一列還是案件內部——
     * 因此**兩個地方都會找**（先查詢結果列、再案件內部），找到哪邊就記在紀錄檔裡。
     */
    transmissionButtons: ['傳輸紀錄'],

    /** 案件內部用來看上傳檔案的按鈕文字（傳輸紀錄找不到時的第二條路）。 */
    uploadButtons: ['上傳'],

    /** 在傳輸紀錄／上傳畫面中，用來認出「這一列是 12 導程心電圖」的字樣。 */
    twelveLeadMarkers: ['12導程', '１２導程', '十二導程'],

    /** 上傳時間的欄名／標籤候選（傳輸紀錄與上傳畫面共用）。 */
    uploadTimeLabels: ['上傳時間', '傳輸時間', '傳送時間', '建立時間', '時間'],

    /** 每筆案件之間的緩衝時間（毫秒）。 */
    settleMs: 2000,

    /** 開啟傳輸紀錄／上傳畫面後，等待內容出現的上限（毫秒）。 */
    panelTimeoutMs: 30 * 1000,

    /**
     * 連續失敗幾筆就中止整個查核。
     *
     * 畫面改版時每一筆都會失敗，跑完幾百件只是浪費一兩個小時，
     * 早點停下來讓人看錯誤訊息比較有意義。已完成的進度會保留（見 checkpoint）。
     */
    abortAfterConsecutiveFailures: 5,
  },
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
