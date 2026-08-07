/**
 * 首頁上方的近期任務提醒卡。
 * 預設顯示「已逾期 + 剩 7 個工作日內到期」的未完成業務；點「展開」改為 30 個工作日內。
 * 提醒視窗與剩餘天數皆以「工作日」計算（扣掉週末與國定假日，見 lib/workday），
 * 避免週五看到下週一到期的業務時，因日曆日顯示「剩 3 天」而誤判還有餘裕。
 * 顏色：已逾期＝紅、剩餘工作日在 urgent 天數內＝橙、其餘＝一般色。點擊跳轉業務詳情。
 * 無期限的未完成業務不受視窗限制，永遠顯示於獨立的「未定期限」區段（避免被遺忘）。
 *
 * 純顯示元件：提醒清單的計算來自 lib/taskLogic（純函式），本元件不含資料存取邏輯。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../types/task';
import type { Category } from '../types/category';
import { REMINDER_WORKDAYS } from '../config/constants';
import { daysUntil, getReminderTasks, type ReminderItem } from '../lib/taskLogic';
import {
  isWithinWorkdays,
  isYearCovered,
  workdaysUntil,
  type WorkdayCalendar,
} from '../lib/workday';
import { Card } from './ui';

interface ReminderPanelProps {
  tasks: Task[];
  categories: Category[];
  /** 假日索引（由 useHolidays 提供），決定剩餘工作日怎麼扣。 */
  workdayCalendar: WorkdayCalendar;
}

/** 期限的剩餘量（日曆日供逾期/今天判定，工作日供顯示與急迫度判定）。 */
interface Remaining {
  /** 距離期限的日曆日數：負數＝已逾期、0＝今天到期。 */
  calendarDays: number;
  /** 距離期限還剩幾個工作日（今天到期或已逾期時為 0）。 */
  workdays: number;
  /** 期限所在年份是否有假日資料（沒有的話只扣了週末）。 */
  covered: boolean;
}

/** 計算單一期限的剩餘量。 */
function remainingOf(deadline: string, calendar: WorkdayCalendar): Remaining {
  return {
    calendarDays: daysUntil(deadline),
    workdays: workdaysUntil(deadline, calendar),
    covered: isYearCovered(deadline, calendar),
  };
}

/** 依剩餘量決定文字顏色（逾期紅、剩餘工作日在 urgent 內橙、其餘一般色）。 */
function toneClass({ calendarDays, workdays }: Remaining): string {
  if (calendarDays < 0) return 'text-red-600';
  if (workdays <= REMINDER_WORKDAYS.urgent) return 'text-amber-600';
  return 'text-slate-600';
}

/** 將剩餘量轉為中文描述（逾期以日曆日計，未到期以工作日計）。 */
function remainingLabel({ calendarDays, workdays }: Remaining): string {
  if (calendarDays < 0) return `逾期 ${Math.abs(calendarDays)} 天`;
  if (calendarDays === 0) return '今天到期';
  return `剩 ${workdays} 個工作日`;
}

/** 滑鼠停留時顯示的補充說明：日曆日天數，以及該年份是否有假日資料。 */
function calendarHint({ calendarDays, covered }: Remaining): string | undefined {
  if (calendarDays <= 0) return undefined;
  const base = `日曆日剩 ${calendarDays} 天`;
  return covered ? base : `${base}（該年度尚未匯入國定假日，僅扣除週末）`;
}

export function ReminderPanel({ tasks, categories, workdayCalendar }: ReminderPanelProps) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const withinWorkdays = expanded ? REMINDER_WORKDAYS.expanded : REMINDER_WORKDAYS.default;
  const categoryName = useMemo(() => {
    const map = new Map(categories.map((category) => [category.id, category.name]));
    return (id: string) => map.get(id) ?? '未分類';
  }, [categories]);

  const reminders = useMemo(
    () =>
      getReminderTasks(tasks, (deadline) =>
        isWithinWorkdays(deadline, workdayCalendar, withinWorkdays),
      ),
    [tasks, withinWorkdays, workdayCalendar],
  );

  // 拆成「有期限」與「無期限」兩段：無期限段永遠顯示於有期限段之後。
  const datedReminders = useMemo(
    () => reminders.filter((item) => item.deadline !== null),
    [reminders],
  );
  const undatedReminders = useMemo(
    () => reminders.filter((item) => item.deadline === null),
    [reminders],
  );

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-800">
          近期提醒
          <span className="ml-2 text-xs font-normal text-slate-400">
            （逾期 + {withinWorkdays} 個工作日內到期）
          </span>
        </h2>
        <button
          onClick={() => setExpanded((prev) => !prev)}
          className="text-sm font-medium text-slate-600 hover:underline"
        >
          {expanded
            ? `收合（${REMINDER_WORKDAYS.default} 個工作日）`
            : `展開（${REMINDER_WORKDAYS.expanded} 個工作日）`}
        </button>
      </div>

      {reminders.length === 0 ? (
        <p className="text-sm text-slate-400">目前沒有需要提醒的項目。</p>
      ) : (
        <>
          {datedReminders.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {datedReminders.map((item, index) => {
                // 此段皆為有期限項目，deadline 必為非 null。
                const remaining = remainingOf(item.deadline as string, workdayCalendar);
                return (
                  <li key={`${item.kind}-${item.taskId}-${index}`}>
                    <button
                      onClick={() => navigate(`/tasks/${item.taskId}`)}
                      className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className={`w-24 shrink-0 font-mono text-sm ${toneClass(remaining)}`}>
                        {item.deadline}
                      </span>
                      <span
                        className={`w-24 shrink-0 text-xs font-semibold ${toneClass(remaining)}`}
                        title={calendarHint(remaining)}
                      >
                        {remainingLabel(remaining)}
                      </span>
                      <ReminderTitle item={item} categoryName={categoryName} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {undatedReminders.length > 0 && (
            <div className={datedReminders.length > 0 ? 'mt-3 border-t border-slate-200 pt-3' : ''}>
              <p className="mb-1 text-xs font-medium text-slate-400">未定期限</p>
              <ul className="divide-y divide-slate-100">
                {undatedReminders.map((item, index) => (
                  <li key={`${item.kind}-${item.taskId}-${index}`}>
                    <button
                      onClick={() => navigate(`/tasks/${item.taskId}`)}
                      className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-500">
                        未定期限
                      </span>
                      <ReminderTitle item={item} categoryName={categoryName} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** 提醒項目的名稱 + 待辦徽章 + 屬性標籤（有期限/無期限兩段共用）。 */
function ReminderTitle({
  item,
  categoryName,
}: {
  item: ReminderItem;
  categoryName: (id: string) => string;
}) {
  return (
    <>
      <span className="flex flex-1 items-center gap-2 truncate">
        {item.kind === 'checklist' && (
          <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            待辦
          </span>
        )}
        {item.recurrenceLabel && (
          <span
            className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700"
            title={item.recurrenceLabel}
          >
            定期
          </span>
        )}
        <span className="truncate text-sm font-medium text-slate-800">
          {item.title}
          {item.kind === 'checklist' && item.taskTitle && (
            <span className="ml-1 text-xs font-normal text-slate-400">（{item.taskTitle}）</span>
          )}
        </span>
      </span>
      <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
        {categoryName(item.categoryId)}
      </span>
    </>
  );
}
