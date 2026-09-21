/**
 * 傷票號碼的純邏輯（流水號 ↔ `H00T000` 字串、區間展開）。
 * 不依賴 React、Firebase 或瀏覽器 API，方便獨立測試。
 */
import {
  TRIAGE_TAG_NUMBER,
  TRIAGE_TAG_TOTAL,
  TRIAGE_TAG_ADMIN_UNIT,
  TRIAGE_TAG_UNIT_HINT,
  TRIAGE_TAG_UNIT_WEEKLY_LIMIT,
  TRIAGE_TAG_UNITS,
  TRIAGE_TAG_WEEK_UTC_OFFSET_HOURS,
} from '../config/triageTag';

const TAIL_BASE = 10 ** TRIAGE_TAG_NUMBER.tailDigits;

/**
 * 流水號 → 傷票號碼。例：0 → `H00T000`、1234 → `H01T234`、99999 → `H99T999`。
 * @throws 流水號不是 0 ~ 99999 的整數時
 */
export function formatTriageTagNumber(serial: number): string {
  if (!Number.isInteger(serial) || serial < 0 || serial >= TRIAGE_TAG_TOTAL) {
    throw new Error(`傷票流水號超出範圍（formatTriageTagNumber）：${serial}`);
  }
  const head = String(Math.floor(serial / TAIL_BASE)).padStart(TRIAGE_TAG_NUMBER.headDigits, '0');
  const tail = String(serial % TAIL_BASE).padStart(TRIAGE_TAG_NUMBER.tailDigits, '0');
  return `${TRIAGE_TAG_NUMBER.prefix}${head}${TRIAGE_TAG_NUMBER.separator}${tail}`;
}

/**
 * 從起始流水號展開連續 `count` 個傷票號碼。
 * @throws 區間超出 `H99T999` 時
 */
export function expandTriageTagRange(startSerial: number, count: number): string[] {
  return Array.from({ length: count }, (_, offset) => formatTriageTagNumber(startSerial + offset));
}

/** 區間的顯示文字：一張就只寫一個號碼，多張寫「起 ~ 迄」。 */
export function describeTriageTagRange(startSerial: number, count: number): string {
  const first = formatTriageTagNumber(startSerial);
  if (count <= 1) return first;
  return `${first} ~ ${formatTriageTagNumber(startSerial + count - 1)}`;
}

/** 還剩幾個號碼可以發（下一個流水號之後到 `H99T999`）。 */
export function remainingTriageTags(nextSerial: number): number {
  return Math.max(0, TRIAGE_TAG_TOTAL - nextSerial);
}

const MS_PER_DAY = 86_400_000;
const WEEK_OFFSET_MS = TRIAGE_TAG_WEEK_UTC_OFFSET_HOURS * 3_600_000;

/**
 * 某個時間點屬於「第幾週」（台灣時間、週一起算）。
 *
 * 1970-01-01 是星期四，所以「本地日序 + 3」再除以 7 就剛好在每個週一跳號。
 * 安全規則 `triageWeekIndex()` 用伺服器時間做一模一樣的計算，兩邊必須一致。
 */
export function triageTagWeekIndex(time: Date): number {
  const localDay = Math.floor((time.getTime() + WEEK_OFFSET_MS) / MS_PER_DAY);
  return Math.floor((localDay + 3) / 7);
}

/** 某一週的顯示文字，例：`9/21（一）～ 9/27（日）`。 */
export function describeTriageTagWeek(weekIndex: number): string {
  const monday = new Date((weekIndex * 7 - 3) * MS_PER_DAY);
  const sunday = new Date(monday.getTime() + 6 * MS_PER_DAY);
  // 這兩個 Date 本身就是「台灣日期的 00:00 UTC」，所以用 UTC 取值。
  const label = (date: Date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  return `${label(monday)}（一）～ ${label(sunday)}（日）`;
}

/**
 * 檢查單位：月報表上的分隊都可以；「救護科」只有管理員可以選。
 * @returns 錯誤訊息；沒問題回傳 null
 */
export function validateTriageTagUnit(unit: string, isAdminUser: boolean): string | null {
  const trimmed = unit.trim();
  if (trimmed === TRIAGE_TAG_ADMIN_UNIT) return isAdminUser ? null : `「${TRIAGE_TAG_ADMIN_UNIT}」只有管理員可以選。`;
  return TRIAGE_TAG_UNITS.includes(trimmed) ? null : TRIAGE_TAG_UNIT_HINT;
}

/** 這個單位每週最多幾張；null＝不限（管理員的救護科）。 */
export function triageTagWeeklyLimitFor(unit: string): number | null {
  return unit.trim() === TRIAGE_TAG_ADMIN_UNIT ? null : TRIAGE_TAG_UNIT_WEEKLY_LIMIT;
}
