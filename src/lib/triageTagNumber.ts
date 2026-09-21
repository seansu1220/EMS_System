/**
 * 傷票號碼的純邏輯（流水號 ↔ `H00T000` 字串、區間展開）。
 * 不依賴 React、Firebase 或瀏覽器 API，方便獨立測試。
 */
import { TRIAGE_TAG_NUMBER, TRIAGE_TAG_TOTAL } from '../config/triageTag';

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
