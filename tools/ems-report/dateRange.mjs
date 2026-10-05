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
 * 取得「今天往回推 N 個月」到今天的區間，供解鎖流程查詢用。
 *
 * 起日採「先退月份、再夾到該月實際天數」的算法：
 * 直接 `setMonth(-2)` 遇到 4/30 這種日子會溢位成 3/2，反而讓查詢期間變短而漏案。
 *
 * @param {number} [months] 往回推幾個月
 * @param {Date} [today] 基準日期（可注入以便測試）
 * @returns {MonthRange} label 為說明文字，start/end 為 `YYYY-MM-DD`
 */
export function getRecentRange(months = 2, today = new Date()) {
  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`往回推的月份數必須是 1 以上的整數，收到：${months}`);
  }
  const endYear = today.getFullYear();
  const endMonth = today.getMonth();
  const endDay = today.getDate();

  const startMonthFirstDay = new Date(endYear, endMonth - months, 1);
  const daysInStartMonth = new Date(
    startMonthFirstDay.getFullYear(),
    startMonthFirstDay.getMonth() + 1,
    0,
  ).getDate();
  const startDay = Math.min(endDay, daysInStartMonth);

  const toIso = (year, monthIndex, day) => `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
  return {
    label: `近 ${months} 個月`,
    start: toIso(startMonthFirstDay.getFullYear(), startMonthFirstDay.getMonth(), startDay),
    end: toIso(endYear, endMonth, endDay),
  };
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
 * 解析使用者輸入的一個日期，回傳 `YYYY-MM-DD`；看不懂或不是真的日期就丟錯（不猜）。
 *
 * 接受的寫法（使用者多半直接照系統畫面或公文抄）：
 * `2026-09-01`、`2026/9/1`、`2026.9.1`、`20260901`、民國 `115/09/01`、`1150901`。
 * 年份小於 1000 一律當成民國年。
 *
 * @param {string} text
 * @returns {string} `YYYY-MM-DD`
 */
export function parseUserDate(text) {
  const raw = String(text ?? '').trim();
  const separated = /^(\d{2,4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  const compact = /^(\d{3,4})(\d{2})(\d{2})$/.exec(raw);
  const matched = separated ?? compact;
  if (!matched) {
    throw new Error(`看不懂的日期：「${raw}」（請寫成 2026-09-01，或民國 115/09/01）`);
  }
  const yearNumber = Number(matched[1]);
  const year = yearNumber < 1000 ? yearNumber + 1911 : yearNumber;
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  // 用 Date 反推回來檢查，2/30、13 月這種不存在的日期會對不上。
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`不存在的日期：「${raw}」`);
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * 由使用者指定的起訖日組出查詢期間。
 *
 * `label` 會用在產出檔名上（`2026-09-01至2026-09-30`），所以只用日期組成，不放說明文字。
 *
 * @param {string} fromText 起日（任何 `parseUserDate` 看得懂的寫法）
 * @param {string} toText 迄日
 * @returns {MonthRange}
 */
export function buildCustomRange(fromText, toText) {
  const start = parseUserDate(fromText);
  const end = parseUserDate(toText);
  if (start > end) {
    throw new Error(`起日（${start}）晚於迄日（${end}），請對調後再試`);
  }
  return { label: `${start}至${end}`, start, end };
}

/**
 * 查詢期間有幾天（含頭尾）。
 * @param {MonthRange} range
 * @returns {number}
 */
export function countRangeDays(range) {
  const toUtc = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((toUtc(range.end) - toUtc(range.start)) / 86400000) + 1;
}

/**
 * 把期間前後各放寬幾天（回傳新物件，不改動輸入）。
 * @param {MonthRange} range
 * @param {number} days
 * @returns {MonthRange}
 */
export function padRange(range, days) {
  const shift = (iso, delta) => {
    const date = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + delta));
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  };
  return { label: range.label, start: shift(range.start, -days), end: shift(range.end, days) };
}

/**
 * 依系統日期元件的格式樣板輸出日期字串。
 *
 * 樣板沿用 My97DatePicker 的寫法（該系統的日期欄位就是用這套元件），支援：
 * `ryyy`（民國年）、`yyyy`（西元年）、`yy`（西元年後兩碼）、`MM`（月）、`dd`（日）、
 * `HH`（時）、`mm`（分）、`ss`（秒）。
 *
 * 系統實際使用的是 `yyyy-MM-dd HH:mm:ss`，**若不處理時間部分，樣板中的
 * `HH:mm:ss` 會被原樣留在字串裡**，導致填入的查詢條件無效（曾因此撈到全部資料）。
 *
 * @param {string} isoDate `YYYY-MM-DD`
 * @param {string} pattern 例如 `yyyy-MM-dd`、`yyyy-MM-dd HH:mm:ss`、`ryyy/MM/dd`
 * @param {{endOfDay?: boolean}} [options] 有時間部分時，起日用 00:00:00、迄日用 23:59:59
 * @returns {string}
 */
export function formatDateForSite(isoDate, pattern, options = {}) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!matched) throw new Error(`日期須為 YYYY-MM-DD，收到：${isoDate}`);
  const [, year, month, day] = matched;
  if (!pattern || !/[yMd]/.test(pattern)) {
    throw new Error(`無效的日期格式樣板：${pattern}`);
  }

  const endOfDay = options.endOfDay === true;
  const tokens = {
    ryyy: String(Number(year) - 1911),
    yyyy: year,
    yy: year.slice(2),
    MM: month,
    dd: day,
    HH: endOfDay ? '23' : '00',
    mm: endOfDay ? '59' : '00',
    ss: endOfDay ? '59' : '00',
  };
  // 一次掃描完成取代，避免先替換出的數字被後續規則再次比對到。
  return pattern.replace(/ryyy|yyyy|yy|MM|dd|HH|mm|ss/g, (token) => tokens[token]);
}
