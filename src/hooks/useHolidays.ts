/**
 * 假日清單 hook：合併「程式內建」與「管理員匯入」兩個來源，
 * 同一年以匯入版本為準（新年度公布後不必重新部署程式）。
 *
 * 讀取失敗時不阻擋畫面：仍以內建清單運作，最壞情況只是少扣新公布的假日。
 */
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from './useAuth';
import { subscribeHolidayCalendars } from '../services/holidayService';
import { BUILTIN_HOLIDAY_CALENDARS } from '../config/holidays';
import { buildWorkdayCalendar, type WorkdayCalendar } from '../lib/workday';
import type { HolidayCalendar } from '../types/holiday';

interface UseHolidaysResult {
  /** 合併後的年度清單（依年份小到大）。 */
  calendars: HolidayCalendar[];
  /** 計算用的假日索引（傳給 workdaysUntil）。 */
  workdayCalendar: WorkdayCalendar;
  loading: boolean;
  error: string | null;
}

/** 內建 + 匯入合併：同年份以匯入版本覆蓋內建版本。 */
function mergeCalendars(imported: HolidayCalendar[]): HolidayCalendar[] {
  const byYear = new Map<number, HolidayCalendar>();
  for (const calendar of BUILTIN_HOLIDAY_CALENDARS) byYear.set(calendar.year, calendar);
  for (const calendar of imported) byYear.set(calendar.year, calendar);
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

export function useHolidays(): UseHolidaysResult {
  const { user } = useAuth();
  const [imported, setImported] = useState<HolidayCalendar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setImported([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubscribe = subscribeHolidayCalendars(
      (list) => {
        setImported(list);
        setError(null);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [user]);

  const calendars = useMemo(() => mergeCalendars(imported), [imported]);
  const workdayCalendar = useMemo(() => buildWorkdayCalendar(calendars), [calendars]);

  return { calendars, workdayCalendar, loading, error };
}
