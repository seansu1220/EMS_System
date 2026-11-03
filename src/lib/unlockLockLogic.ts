/**
 * 解鎖工單「鎖定時段」的純邏輯（月份換算、是否落在鎖定範圍、鎖定／解鎖後的新設定）。
 * 不依賴 React 或 Firebase，皆為純函式。
 *
 * ⚠️ `isTemsisLocked` 的判斷方式必須與 `firebase/firestore.rules` 的 `temsisInLockedPeriod()`
 * 以及 `tools/ems-report/unlockQueue.mjs` 的 `isTemsisInLockedPeriod()` **完全相同**：
 * 取 TEMSIS 前 4 碼與第 5～6 碼組成 `YYYY-MM`，跟鎖定月份做**字串大小比較**。
 * 規則語言沒辦法解析日期，三邊都用同一種字串比法，才不會網頁說可以、規則卻擋下。
 */
import { ROC_YEAR_OFFSET } from '../config/constants';
import type { MonthKey } from '../types/unlockPolicy';

/** 西元年月 → `YYYY-MM`。 */
export function toMonthKey(year: number, month: number): MonthKey {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** `YYYY-MM` → 西元年與月；格式不對回傳 null。 */
export function parseMonthKey(monthKey: MonthKey): { year: number; month: number } | null {
  const matched = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!matched) return null;
  const month = Number(matched[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(matched[1]), month };
}

/** 某個時間點所在的月份（本地時區）。 */
export function monthKeyOf(date: Date): MonthKey {
  return toMonthKey(date.getFullYear(), date.getMonth() + 1);
}

/** 前一個月（`2026-01` → `2025-12`）。 */
export function previousMonthKey(monthKey: MonthKey): MonthKey {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) throw new Error(`月份格式不正確（unlockLockLogic.previousMonthKey）：${monthKey}`);
  return parsed.month === 1
    ? toMonthKey(parsed.year - 1, 12)
    : toMonthKey(parsed.year, parsed.month - 1);
}

/** `2026-09` → `115 年 9 月`（給人看的民國年月）。 */
export function formatRocMonth(monthKey: MonthKey): string {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return monthKey;
  return `${parsed.year - ROC_YEAR_OFFSET} 年 ${parsed.month} 月`;
}

/** TEMSIS 前 6 碼組成的 `YYYY-MM`（不檢查是否為合法月份，與安全規則同樣只取字串）。 */
export function temsisMonthKey(temsis: string): MonthKey {
  return `${temsis.slice(0, 4)}-${temsis.slice(4, 6)}`;
}

/**
 * 這個 TEMSIS 的案件月份是否落在鎖定時段內（鎖定月份當月也算）。
 *
 * @param lockedThroughMonth 鎖定到哪個月（含）；null＝沒有鎖定
 */
export function isTemsisLocked(temsis: string, lockedThroughMonth: MonthKey | null): boolean {
  if (lockedThroughMonth === null || temsis.length < 6) return false;
  return temsisMonthKey(temsis) <= lockedThroughMonth;
}

/**
 * 「鎖定到這個月」之後的新設定。
 *
 * 鎖定一律是「這個月（含）以前全部」，所以只往後推才有意義；
 * 選的月份已經在鎖定範圍內時回傳錯誤訊息，避免誤按把後面已鎖的月份解開。
 *
 * @param current 目前鎖定到哪個月；null＝沒有鎖定
 * @param chosen 要鎖定到哪個月
 * @param thisMonth 現在的月份（不可鎖未來的月份：那會連還在處理中的新案件一起鎖住）
 */
export function planLock(
  current: MonthKey | null,
  chosen: MonthKey,
  thisMonth: MonthKey,
): { ok: true; next: MonthKey } | { ok: false; message: string } {
  if (chosen > thisMonth) {
    return { ok: false, message: `不能鎖定還沒到的月份（${formatRocMonth(chosen)}）。` };
  }
  if (current !== null && chosen <= current) {
    return {
      ok: false,
      message: `${formatRocMonth(chosen)}已經在鎖定範圍內（目前鎖到 ${formatRocMonth(current)}）。`
        + '要開放這個月請按「從這個月起解鎖」。',
    };
  }
  return { ok: true, next: chosen };
}

/**
 * 「從這個月起解鎖」之後的新設定：鎖定範圍退回到前一個月。
 *
 * 鎖定是連續的一段（某月以前全部），沒辦法只開中間某個月；
 * 解鎖某個月＝這個月以後全部開放，以前的維持鎖定。
 *
 * @returns 新的鎖定月份（選的月份的前一個月），或錯誤訊息
 */
export function planUnlock(
  current: MonthKey | null,
  chosen: MonthKey,
): { ok: true; next: MonthKey } | { ok: false; message: string } {
  if (current === null || chosen > current) {
    return { ok: false, message: `${formatRocMonth(chosen)}本來就沒有鎖定。` };
  }
  return { ok: true, next: previousMonthKey(chosen) };
}

/** 月份選單用的民國年清單（由新到舊）。 */
export function rocYearOptions(firstRocYear: number, thisMonth: MonthKey): number[] {
  const parsed = parseMonthKey(thisMonth);
  const lastRocYear = (parsed?.year ?? new Date().getFullYear()) - ROC_YEAR_OFFSET;
  const years: number[] = [];
  for (let year = lastRocYear; year >= firstRocYear; year -= 1) years.push(year);
  return years;
}
