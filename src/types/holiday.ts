/**
 * 國定假日（辦公日曆表）的資料型別。
 *
 * 只保存「與預設不同的例外日」，不保存整年 365 天：
 * 預設規則是「週一～週五上班、週六日放假」（見 WORKDAY_WEEKDAYS），
 * 因此一整年只需記約 20 筆例外，資料量小也方便人工核對。
 */

/** 資料來源：程式內建，或由管理員匯入官方檔案。 */
export type HolidaySource = 'builtin' | 'imported';

/** 單一例外日。 */
export interface HolidayEntry {
  /** 日期（yyyy-MM-dd）。 */
  date: string;
  /** 名稱（例：開國紀念日、補假、補行上班）。 */
  name: string;
}

/** 某一年的辦公日曆例外清單。 */
export interface HolidayCalendar {
  /** 西元年（同時作為 Firestore 文件 ID）。 */
  year: number;
  /** 平日卻放假的日子（國定假日、彈性放假的補假）。 */
  holidays: HolidayEntry[];
  /** 週末卻要上班的日子（補班日）。 */
  workdays: HolidayEntry[];
  /** 全年放假總天數（含週末），由匯入來源統計，僅供人工核對用。 */
  offDayCount: number;
  /** 資料來源。 */
  source: HolidaySource;
  /** 最後更新時間（ISO 字串；內建清單為空字串）。 */
  updatedAt: string;
}
