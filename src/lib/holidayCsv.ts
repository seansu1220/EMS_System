/**
 * 解析行政院人事行政總處「政府行政機關辦公日曆表」CSV（純函式，不依賴 React/Firebase）。
 *
 * 官方檔案格式（數字版）：
 *   西元日期,星期,是否放假,備註
 *   20260101,四,2,開國紀念日
 * 「是否放假」欄：0＝上班、2＝放假。整份檔案是一整年 365/366 天的逐日清單。
 *
 * 本解析器只留下「與預設不同的例外日」（平日放假、週末上班），
 * 因為預設規則已由 WORKDAY_WEEKDAYS 涵蓋，存整年只是浪費空間也難以核對。
 * 為了容錯，日期同時接受 20260101 / 2026-01-01 / 2026/1/1 三種寫法。
 */
import type { HolidayCalendar, HolidayEntry } from '../types/holiday';
import { WORKDAY_WEEKDAYS } from '../config/constants';

/** 解析結果：成功的年度清單 + 需要讓使用者知道的問題。 */
export interface HolidayCsvParseResult {
  /** 可匯入的年度清單（依年份小到大）。 */
  calendars: HolidayCalendar[];
  /** 阻擋匯入的問題（例如某年資料不完整）。 */
  errors: string[];
}

/** 一年的最少天數：官方檔案必為整年，低於此值視為檔案不完整。 */
const MIN_DAYS_PER_YEAR = 350;

/** 表示「放假」的欄位值（官方用 2；另接受常見的是/否寫法以防格式微調）。 */
const OFF_DAY_VALUES = new Set(['2', '是', 'true', 'y', 'yes']);
/** 表示「上班」的欄位值。 */
const WORK_DAY_VALUES = new Set(['0', '否', 'false', 'n', 'no']);

/** 單列解析後的原始資料。 */
interface CalendarRow {
  date: string;
  isOffDay: boolean;
  name: string;
}

/** 將各種日期寫法正規化為 yyyy-MM-dd；無法辨識回傳 null。 */
function normalizeDate(raw: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const separated = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (separated) {
    const month = separated[2].padStart(2, '0');
    const day = separated[3].padStart(2, '0');
    return `${separated[1]}-${month}-${day}`;
  }
  return null;
}

/** 日期是否真實存在（擋掉 2026-02-30 這種列）。 */
function isRealDate(dateStr: string): boolean {
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${parsed.getFullYear()}-${month}-${day}` === dateStr;
}

/** 解析單列；不是資料列（標題列、空白列、格式不符）時回傳 null。 */
function parseRow(line: string): CalendarRow | null {
  const cells = line.split(',');
  if (cells.length < 3) return null;

  const date = normalizeDate(cells[0]);
  if (date === null || !isRealDate(date)) return null;

  const flag = cells[2].trim().toLowerCase();
  const isOffDay = OFF_DAY_VALUES.has(flag);
  if (!isOffDay && !WORK_DAY_VALUES.has(flag)) return null;

  return { date, isOffDay, name: (cells[3] ?? '').trim() };
}

/** 該日在預設規則下是否為上班日（週一～週五）。 */
function isWeekdayByDefault(dateStr: string): boolean {
  return WORKDAY_WEEKDAYS.includes(new Date(`${dateStr}T00:00:00`).getDay());
}

/** 把某一年的所有資料列整理成 HolidayCalendar。 */
function buildCalendar(year: number, rows: CalendarRow[], updatedAt: string): HolidayCalendar {
  const holidays: HolidayEntry[] = [];
  const workdays: HolidayEntry[] = [];
  let offDayCount = 0;

  for (const row of rows) {
    const weekdayDefault = isWeekdayByDefault(row.date);
    if (row.isOffDay) offDayCount += 1;
    if (row.isOffDay && weekdayDefault) {
      holidays.push({ date: row.date, name: row.name || '調整放假' });
    } else if (!row.isOffDay && !weekdayDefault) {
      workdays.push({ date: row.date, name: row.name || '補行上班' });
    }
  }

  const byDate = (a: HolidayEntry, b: HolidayEntry) => a.date.localeCompare(b.date);
  return {
    year,
    holidays: holidays.sort(byDate),
    workdays: workdays.sort(byDate),
    offDayCount,
    source: 'imported',
    updatedAt,
  };
}

/**
 * 解析辦公日曆表 CSV 內容。
 * @param text CSV 全文（可含 BOM，可一次包含多個年度）
 * @param updatedAt 匯入時間（ISO 字串），寫入每個年度清單
 */
export function parseOfficeCalendarCsv(text: string, updatedAt: string): HolidayCsvParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const rowsByYear = new Map<number, CalendarRow[]>();
  const seenDates = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseRow(line);
    // 標題列與雜訊列會在此被略過；真正的問題（整年沒資料）由下方天數檢查攔截。
    if (row === null || seenDates.has(row.date)) continue;
    seenDates.add(row.date);
    const year = Number(row.date.slice(0, 4));
    const rows = rowsByYear.get(year);
    if (rows) rows.push(row);
    else rowsByYear.set(year, [row]);
  }

  if (rowsByYear.size === 0) {
    return {
      calendars: [],
      errors: [
        '這個檔案裡找不到辦公日曆資料。請確認下載的是「數字版」CSV（欄位為 西元日期,星期,是否放假,備註），而不是 Google 行事曆專用版或 PDF。',
      ],
    };
  }

  const calendars: HolidayCalendar[] = [];
  const errors: string[] = [];
  for (const [year, rows] of [...rowsByYear.entries()].sort((a, b) => a[0] - b[0])) {
    if (rows.length < MIN_DAYS_PER_YEAR) {
      errors.push(
        `${year} 年只讀到 ${rows.length} 天，官方檔案應為整年 365 天。` +
          '為避免漏掉假日造成天數算錯，這一年不予匯入，請改用完整的年度檔案。',
      );
      continue;
    }
    calendars.push(buildCalendar(year, rows, updatedAt));
  }
  return { calendars, errors };
}
