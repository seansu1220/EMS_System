/**
 * 日期時間解析與比較 —— 全部是純函式（輸入 → 輸出，無副作用），可單獨測試。
 *
 * 用途：判斷「12 導程心電圖的上傳時間」是不是在「到院時間」之前。
 * 這個判斷會直接決定一件案子算不算數，因此設計原則是
 * **看不懂或有歧義就回報「無法判定」，絕不猜**——猜錯會讓分隊的成績莫名其妙變動。
 *
 * ⚠ 個資原則：本模組只處理時間字串，不接觸也不保留任何個人欄位。
 */

/**
 * @typedef {Object} ParsedTime
 * @property {number} epochMs 換算後的時間（毫秒）
 * @property {'datetime'|'monthday'|'timeonly'} kind
 *   `datetime`＝年月日時分都有；
 *   `monthday`＝只有月日（年份由呼叫端補）；
 *   `timeonly`＝只有時分（日期由呼叫端補），**這種最容易跨日誤判**
 * @property {string} matched 實際比對到的那一段原文（供人核對抓對了沒）
 */

/** 民國年的上限：3 位數以內視為民國年（`115/07/02`）。 */
const ROC_YEAR_MAX = 300;

/**
 * 早於這一年就當成「沒有這個時間」。
 *
 * ⚠ 這是實跑（2026-08-11）踩到的坑。系統的到院時間欄沒填時，
 * 匯出檔寫的是 `0001/01/01 00:00:00`（.NET 的 DateTime 最小值），
 * 而不是空白。它長得完全像一個合法日期，還會被當成民國 1 年換算成 1912，
 * 於是「上傳時間晚於 1912 年」永遠成立——整件被判成到院後，分隊白白掉一件。
 *
 * 認出它之後回 null（＝讀不到），呼叫端才會往下一個來源（查詢結果、紀錄表 PDF）
 * 找真正的到院時間；真的都沒有就列入人工確認，而不是給一個錯的結論。
 */
const EARLIEST_PLAUSIBLE_YEAR = 2000;

/** 年月日 + 時分[秒]，年份 4 碼（西元）或 2~3 碼（民國）。 */
const FULL_PATTERN =
  /(\d{2,4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?\s*[T\s]\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/;

/** 只有月日 + 時分[秒]（`07-02 07:32`，救護紀錄表 PDF 上常見）。 */
const MONTH_DAY_PATTERN =
  /(?<![\d/-])(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?\s+(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/;

/** 只有時分[秒]。 */
const TIME_ONLY_PATTERN = /(?<![\d:])(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?(?![\d:])/;

/**
 * 兩個「只有時間」的值相差超過這個時數就視為無法判定。
 *
 * 為什麼需要：兩邊都只有時分時，程式只能假設是同一天。
 * 實際上「23:50 上傳、隔天 00:30 到院」會被算成上傳在到院之後——完全相反。
 * 差距大到不合常理時就承認判斷不了，交給人看（使用者選擇的處理方式）。
 */
const AMBIGUOUS_GAP_HOURS = 12;

/** 用 UTC 組時間：只做「兩個時間誰先誰後」的比較，不需要時區，用 UTC 最單純。 */
function toEpochMs(year, month, day, hour, minute, second) {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** 民國年轉西元年；已經是西元年（4 碼）則原樣回傳。 */
function normalizeYear(rawYear) {
  const year = Number(rawYear);
  return year <= ROC_YEAR_MAX ? year + 1911 : year;
}

/** 數值落在合理範圍內才算數（`13/45` 這種顯然不是日期）。 */
function isValidParts(month, day, hour, minute, second) {
  return (
    month >= 1 && month <= 12
    && day >= 1 && day <= 31
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
  );
}

/** 年份是不是真的可能是一件救護案件的年份（見 {@link EARLIEST_PLAUSIBLE_YEAR}）。 */
const isPlausibleYear = (year) => year >= EARLIEST_PLAUSIBLE_YEAR;

/**
 * 從一段文字裡解析出日期時間。
 *
 * 依序嘗試三種樣式：完整年月日 → 只有月日 → 只有時分。
 * 越完整的越優先，避免 `2026/07/02 12:44` 被「只有時分」的樣式先咬走。
 *
 * @param {string} text 可能夾雜其他文字（例如整格儲存格內容）
 * @param {{defaultYear?: number, defaultDate?: string}} [context]
 *   `defaultYear`：只有月日時，用哪一年補齊（通常是查詢月份的年份）。
 *   `defaultDate`：只有時分時，用哪一天補齊，格式 `YYYY-MM-DD`。
 * @returns {ParsedTime|null} 看不出時間時回傳 null（**不猜**）
 */
export function parseDateTime(text, context = {}) {
  const source = String(text ?? '');
  if (!source) return null;

  // ⚠ 三種樣式是「前一種完全沒比對到才試下一種」，不是「前一種算不出來就試下一種」。
  // 差別很重要：`2026-13-02 12:44` 這種壞掉的日期若往下掉到「只有時分」，
  // 會被安上預設日期而變成一個看起來很有把握、實際上憑空捏造的時間。
  // 樣式對上但數值不合理＝資料本身有問題，回 null 讓它進人工確認清單才對。
  const full = FULL_PATTERN.exec(source);
  if (full) {
    const [matched, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = full;
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const hour = Number(rawHour);
    const minute = Number(rawMinute);
    const second = Number(rawSecond ?? 0);
    if (!isValidParts(month, day, hour, minute, second)) return null;
    const year = normalizeYear(rawYear);
    // 空值哨兵（`0001/01/01`）長得像日期，但那代表「這一欄沒填」，不是一個時間。
    if (!isPlausibleYear(year)) return null;
    return {
      epochMs: toEpochMs(year, month, day, hour, minute, second),
      kind: 'datetime',
      matched: matched.trim(),
    };
  }

  const monthDay = MONTH_DAY_PATTERN.exec(source);
  if (monthDay) {
    const [matched, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = monthDay;
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const hour = Number(rawHour);
    const minute = Number(rawMinute);
    const second = Number(rawSecond ?? 0);
    if (!isValidParts(month, day, hour, minute, second)) return null;
    // 沒給年份就無從補齊，不猜（呼叫端會把它當成讀不到而列入人工確認）。
    if (!context.defaultYear || !isPlausibleYear(context.defaultYear)) return null;
    return {
      epochMs: toEpochMs(context.defaultYear, month, day, hour, minute, second),
      kind: 'monthday',
      matched: matched.trim(),
    };
  }

  const timeOnly = TIME_ONLY_PATTERN.exec(source);
  if (timeOnly && context.defaultDate) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(context.defaultDate);
    const [matched, rawHour, rawMinute, rawSecond] = timeOnly;
    const hour = Number(rawHour);
    const minute = Number(rawMinute);
    const second = Number(rawSecond ?? 0);
    if (parts && isValidParts(1, 1, hour, minute, second) && isPlausibleYear(Number(parts[1]))) {
      return {
        epochMs: toEpochMs(Number(parts[1]), Number(parts[2]), Number(parts[3]), hour, minute, second),
        kind: 'timeonly',
        matched: matched.trim(),
      };
    }
  }

  return null;
}

/**
 * 從一串文字（例如某一列的各個儲存格）中找出第一個解析得出的時間。
 *
 * 由前往後掃，取第一個成功的：表格通常把時間放在固定欄位，
 * 但欄位順序會隨系統改版變動，逐格試比寫死欄位序號耐用。
 *
 * @param {string[]} texts
 * @param {{defaultYear?: number, defaultDate?: string}} [context]
 * @returns {ParsedTime|null}
 */
export function findFirstDateTime(texts, context = {}) {
  for (const text of texts ?? []) {
    const parsed = parseDateTime(text, context);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 判斷「上傳時間是不是在到院時間之前」。
 *
 * @param {ParsedTime|null} upload 12 導程心電圖的上傳／傳輸時間
 * @param {ParsedTime|null} arrival 到院時間
 * @returns {{verdict: '到院前'|'到院後'|'無法判定', reason: string}}
 *   `到院前`＝這件算有做 EKG；`到院後`＝不算；`無法判定`＝列入人工確認清單
 */
export function compareUploadToArrival(upload, arrival) {
  if (!upload && !arrival) return { verdict: '無法判定', reason: '上傳時間與到院時間都讀不到' };
  if (!upload) return { verdict: '無法判定', reason: '讀不到 12 導程的上傳時間' };
  if (!arrival) return { verdict: '無法判定', reason: '讀不到到院時間' };

  // 兩邊都只有時分時，程式只能假設同一天。差距大到不合常理（例如跨過午夜）就承認判斷不了，
  // 硬比會得出完全相反的結論。
  const bothTimeOnly = upload.kind === 'timeonly' && arrival.kind === 'timeonly';
  const gapHours = Math.abs(upload.epochMs - arrival.epochMs) / 3600000;
  if (bothTimeOnly && gapHours > AMBIGUOUS_GAP_HOURS) {
    return {
      verdict: '無法判定',
      reason: `兩個時間都只有時分（上傳 ${upload.matched}、到院 ${arrival.matched}），`
        + `相差 ${gapHours.toFixed(1)} 小時，可能跨日，無法確定先後`,
    };
  }

  if (upload.epochMs < arrival.epochMs) {
    return { verdict: '到院前', reason: `上傳 ${upload.matched} 早於到院 ${arrival.matched}` };
  }
  if (upload.epochMs > arrival.epochMs) {
    return { verdict: '到院後', reason: `上傳 ${upload.matched} 晚於到院 ${arrival.matched}` };
  }
  // 完全相同：說不上是「到院前傳送」，但也不該直接判定沒做。交給人看。
  return {
    verdict: '無法判定',
    reason: `上傳與到院時間完全相同（${upload.matched}），無法判斷先後`,
  };
}
