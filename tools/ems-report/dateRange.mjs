/**
 * 查詢期間計算 — 純函式，無副作用，方便單獨驗證。
 */

/**
 * @typedef {Object} MonthRange
 * @property {string} label 月份標籤，格式 `YYYY-MM`
 * @property {string} start 起日 `YYYY-MM-DD`
 * @property {string} end   迄日 `YYYY-MM-DD`（該月最後一天）
 */

/** 補零成兩位數。 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 取得指定年月的完整月份區間（1 號 ~ 最後一天）。
 * @param {number} year 西元年
 * @param {number} month 月份 1-12
 * @returns {MonthRange}
 */
export function getMonthRange(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`月份必須為 1-12，收到：${month}`);
  }
  // Date 的第 0 天代表上個月最後一天，用來取得當月天數。
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    label: `${year}-${pad2(month)}`,
    start: `${year}-${pad2(month)}-01`,
    end: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

/**
 * 取得「上一個月」的完整區間，這是本工具的預設查詢期間。
 * @param {Date} [today] 基準日期，預設為現在（可注入以便測試）
 * @returns {MonthRange}
 */
export function getPreviousMonthRange(today = new Date()) {
  const year = today.getFullYear();
  const month = today.getMonth(); // 0-based，剛好等於「上個月」的 1-based 值
  return month === 0 ? getMonthRange(year - 1, 12) : getMonthRange(year, month);
}

/**
 * 解析 `--month=YYYY-MM` 參數；未提供時回傳上個月。
 * @param {string|undefined} monthArg
 * @param {Date} [today]
 * @returns {MonthRange}
 */
export function resolveMonthRange(monthArg, today = new Date()) {
  if (!monthArg) return getPreviousMonthRange(today);
  const matched = /^(\d{4})-(\d{1,2})$/.exec(monthArg.trim());
  if (!matched) {
    throw new Error(`--month 格式須為 YYYY-MM（例如 2026-06），收到：${monthArg}`);
  }
  return getMonthRange(Number(matched[1]), Number(matched[2]));
}

/**
 * 依系統日期元件的格式樣板輸出日期字串。
 *
 * 樣板沿用 My97DatePicker 的寫法（該系統的日期欄位就是用這套元件），
 * 支援 `yyyy`（西元年）、`yy`（西元年後兩碼）、`ryyy`（民國年）、`MM`、`dd`。
 * 這樣系統若改用民國年或斜線分隔，只需改樣板不必改程式。
 *
 * @param {string} isoDate `YYYY-MM-DD`
 * @param {string} pattern 例如 `yyyy-MM-dd`、`yyyy/MM/dd`、`ryyy/MM/dd`
 * @returns {string}
 */
export function formatDateForSite(isoDate, pattern) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!matched) throw new Error(`日期須為 YYYY-MM-DD，收到：${isoDate}`);
  const [, year, month, day] = matched;
  if (!pattern || !/[yMd]/.test(pattern)) {
    throw new Error(`無效的日期格式樣板：${pattern}`);
  }
  // ryyy 需先於 yyyy 取代，否則會被 yyyy 規則先吃掉。
  return pattern
    .replace(/ryyy/g, String(Number(year) - 1911))
    .replace(/yyyy/g, year)
    .replace(/yy/g, year.slice(2))
    .replace(/MM/g, month)
    .replace(/dd/g, day);
}
