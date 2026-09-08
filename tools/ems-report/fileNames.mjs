/**
 * 月份產出檔的**命名規則**，以及回頭**認出這些檔案**的規則。
 *
 * 使用者 2026-09-05 要求：**年月寫在檔名最前面**。
 * 舊寫法（`心電圖到院前傳輸率-2026-08.xlsx`）在檔案總管照名稱排序時，
 * 同一個月的東西會被打散成一群不同開頭的檔案，要找「上個月那批」得一個一個看；
 * 月份放前面就自然照時間排在一起。
 *
 * 命名規則與辨識規則**刻意放在同一個檔案**：改了名字卻忘了改清理規則的話，
 * 舊檔會永遠留著——`retention.mjs` 認不出來就不敢刪（它只動認得出來的檔案）。
 */

/** 我們會產出的副檔名。認不出副檔名的檔案一律不動。 */
const EXTENSIONS = 'xlsx|xls|md|csv|json';

/** 新寫法：`2026-08-心電圖到院前傳輸率.xlsx`。 */
const CURRENT_PATTERN = new RegExp(`^(\\d{4})-(\\d{2})-(.+)\\.(${EXTENSIONS})$`, 'i');

/** 舊寫法：`心電圖到院前傳輸率-2026-08.xlsx`（2026-09-05 之前產的檔案還在資料夾裡）。 */
const LEGACY_PATTERN = new RegExp(`-(\\d{4})-(\\d{2})\\.(${EXTENSIONS})$`, 'i');

/**
 * 這個工具會產出的檔名（不含月份與副檔名）。
 *
 * ⚠ 這份名單是**保護使用者自己的檔案**用的，不是裝飾。
 * 新寫法把月份放在最前面，而「2026-08-分隊回覆.xlsx」正是很多人自己會取的名字；
 * 少了這份名單，`retention.mjs` 三個月後會把它當成過期產出刪掉。
 * 認得出來的才算我們的檔案，其餘一律不動。
 *
 * 新增產出檔時**要記得加進來**，否則那份檔案永遠不會被自動清掉。
 */
export const MONTHLY_OUTPUT_NAMES = [
  // out/report/（會發給分隊）
  '到院前預警比率',
  '心電圖到院前傳輸率',
  '心電圖-有處置未勾選清冊',
  '心電圖-有EKG處置無12導程清冊',
  '心電圖待人工確認',
  // out/internal/（內部用）
  '心電圖執行報告',
  '心電圖逐案判定',
  '心電圖查核進度',
  '心電圖類型對撞',
  '二級以上因交通事故救護案件',
];

/**
 * 組出產出檔名：**年月在前**。
 *
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {string} name 產出檔名稱（見 `MONTHLY_OUTPUT_NAMES`）
 * @param {string} extension 副檔名，不含點
 * @returns {string} 例如 `2026-08-心電圖到院前傳輸率.xlsx`
 */
export function monthlyFileName(monthRange, name, extension) {
  return `${monthRange.label}-${name}.${extension}`;
}

/**
 * 同一份產出在 2026-09-05 之前的舊檔名（年月在後）。
 *
 * 用途只有一個：重跑一個**以前跑過的月份**時，把舊名字那一份刪掉。
 * 不刪的話同一個月會留下兩份內容不同、名字不同的報表，遲早有人拿錯。
 *
 * @returns {string} 例如 `心電圖到院前傳輸率-2026-08.xlsx`
 */
export function legacyMonthlyFileName(monthRange, name, extension) {
  return `${name}-${monthRange.label}.${extension}`;
}

/**
 * 從檔名認出它是「哪一個月的產出」。認不出來就回傳 null（那不是我們產的，別動它）。
 *
 * 新舊兩種寫法都認得：資料夾裡還有 2026-09-05 之前產的檔案，
 * 只認新寫法的話那些舊檔會永遠不被清掉。
 *
 * @param {string} fileName 不含路徑的檔名
 * @returns {string|null} `YYYY-MM`
 */
export function monthOfOutputFile(fileName) {
  const current = CURRENT_PATTERN.exec(fileName);
  if (current) {
    // 新寫法一定要對得上名單：月份在前是使用者自己也會用的取名方式（見上方說明）。
    return MONTHLY_OUTPUT_NAMES.includes(current[3]) ? `${current[1]}-${current[2]}` : null;
  }
  const legacy = LEGACY_PATTERN.exec(fileName);
  return legacy ? `${legacy[1]}-${legacy[2]}` : null;
}
