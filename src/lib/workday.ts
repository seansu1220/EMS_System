/**
 * 工作日計算的純邏輯（輸入 → 輸出，無副作用）。
 *
 * 預設規則：週一～週五為工作日（見 WORKDAY_WEEKDAYS）。
 * 再套上假日清單修正兩種例外：平日放假（國定假日、補假）、週末上班（補班日）。
 * 清單沒涵蓋到的年份一律退回預設規則，只扣週六日——寧可少扣，也不要憑空猜假日。
 */
import { WORKDAY_WEEKDAYS } from '../config/constants';
import type { HolidayCalendar } from '../types/holiday';
import { addDaysToDate, daysUntil, today } from './taskLogic';

/**
 * 計算用的假日索引（由 HolidayCalendar 清單攤平成集合，查詢為 O(1)）。
 * 供 UI 與計算共用，不要在元件內自行組裝。
 */
export interface WorkdayCalendar {
  /** 有假日資料的西元年（用於提示使用者哪些年份尚未涵蓋）。 */
  coveredYears: ReadonlySet<number>;
  /** 平日卻放假的日期集合（yyyy-MM-dd）。 */
  holidayDates: ReadonlySet<string>;
  /** 週末卻要上班的日期集合（yyyy-MM-dd）。 */
  workdayDates: ReadonlySet<string>;
}

/**
 * 逐日掃描的上限天數。
 * 提醒卡最遠只看 30 天，正常情境遠低於此；設上限是為了避免使用者誤植年份
 * （例如把期限打成 9999 年）時在畫面渲染中跑上百萬次迴圈。
 * 超過上限的日期一律以「只扣週末」的算式估算——那麼遠的年份本來就沒有假日資料。
 */
const MAX_SCAN_DAYS = 800;

/** 空清單（尚未載入假日資料時使用，等同只扣週六日）。 */
export const EMPTY_WORKDAY_CALENDAR: WorkdayCalendar = {
  coveredYears: new Set<number>(),
  holidayDates: new Set<string>(),
  workdayDates: new Set<string>(),
};

/** 將各年度的假日清單攤平成查詢用的集合。 */
export function buildWorkdayCalendar(calendars: readonly HolidayCalendar[]): WorkdayCalendar {
  const coveredYears = new Set<number>();
  const holidayDates = new Set<string>();
  const workdayDates = new Set<string>();

  for (const calendar of calendars) {
    coveredYears.add(calendar.year);
    for (const entry of calendar.holidays) holidayDates.add(entry.date);
    for (const entry of calendar.workdays) workdayDates.add(entry.date);
  }
  return { coveredYears, holidayDates, workdayDates };
}

/** 該日期在「不看假日清單」時是否為上班日（週一～週五）。 */
function isWeekdayByDefault(dateStr: string): boolean {
  return WORKDAY_WEEKDAYS.includes(new Date(`${dateStr}T00:00:00`).getDay());
}

/**
 * 判斷某日是否為工作日：假日清單的例外優先，其餘依週一～週五的預設規則。
 * @param dateStr yyyy-MM-dd
 */
export function isWorkday(dateStr: string, calendar: WorkdayCalendar): boolean {
  if (calendar.holidayDates.has(dateStr)) return false;
  if (calendar.workdayDates.has(dateStr)) return true;
  return isWeekdayByDefault(dateStr);
}

/** 該年份是否有假日資料（沒有的話天數只扣週末，需在畫面上說明）。 */
export function isYearCovered(dateStr: string, calendar: WorkdayCalendar): boolean {
  return calendar.coveredYears.has(Number(dateStr.slice(0, 4)));
}

/** 只扣週末的估算（供超出掃描上限的極遠日期使用）。 */
function weekendOnlyWorkdays(from: string, totalDays: number): number {
  const fullWeeks = Math.floor(totalDays / 7);
  const restDays = totalDays % 7;
  let workdays = fullWeeks * WORKDAY_WEEKDAYS.length;
  let cursor = addDaysToDate(from, fullWeeks * 7);
  for (let step = 0; step < restDays; step += 1) {
    cursor = addDaysToDate(cursor, 1);
    if (isWeekdayByDefault(cursor)) workdays += 1;
  }
  return workdays;
}

/**
 * 計算距離期限還剩幾個工作日：統計 from（不含）到 deadline（含）之間的工作日數。
 * 例：週五看到下週一到期的業務，日曆日剩 3 天，工作日只剩 1 天。
 * 期限為今天或已逾期時回傳 0（逾期天數請改用 daysUntil()，以日曆日呈現較直覺）。
 *
 * @param deadline 期限（yyyy-MM-dd）
 * @param calendar 假日索引（由 buildWorkdayCalendar 產生）
 * @param from 基準日（yyyy-MM-dd），預設今天
 */
export function workdaysUntil(
  deadline: string,
  calendar: WorkdayCalendar,
  from: string = today(),
): number {
  const totalDays = daysUntil(deadline, from);
  if (totalDays <= 0) return 0;
  if (totalDays > MAX_SCAN_DAYS) return weekendOnlyWorkdays(from, totalDays);

  let workdays = 0;
  let cursor = from;
  for (let step = 0; step < totalDays; step += 1) {
    cursor = addDaysToDate(cursor, 1);
    if (isWorkday(cursor, calendar)) workdays += 1;
  }
  return workdays;
}

/**
 * 期限是否落在「剩餘 N 個工作日」的視窗內（已逾期、今天到期一律算在內）。
 *
 * 等同於 workdaysUntil(deadline) <= limit，但一超過門檻就中止掃描：
 * 提醒卡每次渲染都要對所有未完成業務判定一次，遠期業務（例如明年才到期）
 * 不該為了算出精確天數而逐日跑上數百圈。
 *
 * @param deadline 期限（yyyy-MM-dd）
 * @param calendar 假日索引（由 buildWorkdayCalendar 產生）
 * @param limit 視窗天數（工作日）
 * @param from 基準日（yyyy-MM-dd），預設今天
 */
export function isWithinWorkdays(
  deadline: string,
  calendar: WorkdayCalendar,
  limit: number,
  from: string = today(),
): boolean {
  const totalDays = daysUntil(deadline, from);
  if (totalDays <= 0) return true; // 已逾期或今天到期。
  if (totalDays > MAX_SCAN_DAYS) return false; // 那麼遠的期限必定超出提醒視窗。

  let workdays = 0;
  let cursor = from;
  for (let step = 0; step < totalDays; step += 1) {
    cursor = addDaysToDate(cursor, 1);
    if (isWorkday(cursor, calendar)) workdays += 1;
    if (workdays > limit) return false;
  }
  return true;
}
