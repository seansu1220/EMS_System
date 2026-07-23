/**
 * 定期業務的週期計算純邏輯。
 * 不依賴 React 或 Firebase，皆為純函式（輸入 → 輸出，無副作用），方便獨立測試。
 * 日期一律以 `T00:00:00` 建立本地日期避免時區偏移（比照 lib/taskLogic.ts 的作法）。
 */
import type { RecurrenceRule, Task } from '../types/task';
import { addDaysToDate } from './taskLogic';

/** 星期中文對照（索引 0=日 … 6=六）。 */
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 取得指定年月的天數（month 為 1-12）。
 * 以「下個月的第 0 天」即為當月最後一天的技巧計算。
 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 將 day 夾到該年月的合法範圍（如 31 → 2 月取 28/29）。 */
function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/** 由年、月（1-12）、日組出 yyyy-MM-dd 字串。 */
function formatYmd(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * 計算每月固定日的下一次週期日。
 * 當月的 day（超界時夾為月底）若符合條件則取當月，否則取下個月。
 */
function nextMonthly(day: number, fromDate: string, inclusive: boolean): string {
  const from = new Date(`${fromDate}T00:00:00`);
  const year = from.getFullYear();
  const month = from.getMonth() + 1; // 轉為 1-12
  const candidate = formatYmd(year, month, clampDay(year, month, day));
  const comparison = candidate.localeCompare(fromDate);
  if (comparison > 0 || (inclusive && comparison === 0)) return candidate;
  // 推進到下個月（Date 的月份索引為 0-based，傳入 1-12 即代表下個月，並自動處理跨年）。
  const nextMonth = new Date(year, month, 1);
  const nextYear = nextMonth.getFullYear();
  const nextMonthNumber = nextMonth.getMonth() + 1;
  return formatYmd(nextYear, nextMonthNumber, clampDay(nextYear, nextMonthNumber, day));
}

/** 計算每週固定星期幾的下一次週期日。 */
function nextWeekly(weekday: number, fromDate: string, inclusive: boolean): string {
  const current = new Date(`${fromDate}T00:00:00`).getDay();
  let diff = (weekday - current + 7) % 7;
  if (diff === 0 && !inclusive) diff = 7; // 當天即為該星期幾且非 inclusive → 取下週
  return addDaysToDate(fromDate, diff);
}

/**
 * 計算每年固定日期的下一次週期日。
 * 當年該日期若尚未過（inclusive 且為當天亦算）取當年，否則取明年；2/29 於平年夾為 2/28。
 */
function nextYearly(month: number, day: number, fromDate: string, inclusive: boolean): string {
  const year = new Date(`${fromDate}T00:00:00`).getFullYear();
  const candidate = formatYmd(year, month, clampDay(year, month, day));
  const comparison = candidate.localeCompare(fromDate);
  if (comparison > 0 || (inclusive && comparison === 0)) return candidate;
  const nextYear = year + 1;
  return formatYmd(nextYear, month, clampDay(nextYear, month, day));
}

/**
 * 回傳 fromDate 之後（inclusive=true 時含當天）最近的一次週期日（yyyy-MM-dd）。
 * everyNDays 對 inclusive 無意義，一律回傳 addDaysToDate(fromDate, n)。
 * @param rule 週期規則
 * @param fromDate 起算日期（yyyy-MM-dd）
 * @param options.inclusive 為 true 時，當天符合亦視為一次週期日
 */
export function nextOccurrence(
  rule: RecurrenceRule,
  fromDate: string,
  options?: { inclusive?: boolean },
): string {
  const inclusive = options?.inclusive ?? false;
  switch (rule.type) {
    case 'monthly':
      return nextMonthly(rule.day, fromDate, inclusive);
    case 'weekly':
      return nextWeekly(rule.weekday, fromDate, inclusive);
    case 'everyNDays':
      return addDaysToDate(fromDate, rule.n);
    case 'yearly':
      return nextYearly(rule.month, rule.day, fromDate, inclusive);
    default: {
      // 防呆：若出現未知型別（理論上不可能），拋出明確錯誤標明位置。
      const unknown = rule as { type: string };
      throw new Error(`未知的週期型別（recurrence.nextOccurrence）：${unknown.type}`);
    }
  }
}

/** 產生週期規則的中文描述，如「每月 1 號」「每週一」「每 3 天」「每年 6/30」。 */
export function describeRecurrence(rule: RecurrenceRule): string {
  switch (rule.type) {
    case 'monthly':
      return `每月 ${rule.day} 號`;
    case 'weekly':
      return `每週${WEEKDAY_LABELS[rule.weekday] ?? '?'}`;
    case 'everyNDays':
      return `每 ${rule.n} 天`;
    case 'yearly':
      return `每年 ${rule.month}/${rule.day}`;
    default: {
      const unknown = rule as { type: string };
      return `未知週期（${unknown.type}）`;
    }
  }
}

/** 業務是否為定期業務（有週期規則）。 */
export function isRecurring(task: Pick<Task, 'recurrence'>): boolean {
  return task.recurrence !== null;
}
