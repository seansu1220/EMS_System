/**
 * 首頁：上方近期提醒卡 + 下方業務列表。
 * 業務列表提供屬性頁籤篩選、顯示已完成開關、關鍵字搜尋。
 * 篩選/排序邏輯以 useTasks（已排序）與純函式為主，本頁僅組合顯示。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasks } from '../hooks/useTasks';
import { useCategories } from '../hooks/useCategories';
import type { Task } from '../types/task';
import { isDone, isOverdue, sortProgressEntries } from '../lib/taskLogic';
import { describeRecurrence } from '../lib/recurrence';
import { ReminderPanel } from '../components/ReminderPanel';
import { Badge, Button, Card, CenteredSpinner, ErrorBanner, INPUT_CLASS } from '../components/ui';

/** 特殊頁籤值：顯示全部屬性。 */
const ALL_TAB = 'all';

export function HomePage() {
  const navigate = useNavigate();
  const { tasks, loading: tasksLoading, error: tasksError } = useTasks();
  const { categories, error: categoriesError } = useCategories();

  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);
  const [showDone, setShowDone] = useState(false);
  const [keyword, setKeyword] = useState('');

  const categoryName = useMemo(() => {
    const map = new Map(categories.map((category) => [category.id, category.name]));
    return (id: string) => map.get(id) ?? '未分類';
  }, [categories]);

  // 套用頁籤 / 完成 / 關鍵字篩選（tasks 已由 hook 排序）。
  const visibleTasks = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    return tasks.filter((task) => {
      if (!showDone && isDone(task)) return false;
      if (activeTab !== ALL_TAB && task.categoryId !== activeTab) return false;
      if (term) {
        const haystack = `${task.title} ${task.description} ${task.note}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [tasks, showDone, activeTab, keyword]);

  const errorMessage = tasksError ?? categoriesError;

  return (
    <div className="space-y-6">
      <ReminderPanel tasks={tasks} categories={categories} />

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-bold text-slate-800">業務列表</h2>
          <Button onClick={() => navigate('/tasks/new')}>新增業務</Button>
        </div>

        {/* 屬性頁籤（手機可橫向捲動） */}
        <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto pb-1">
          <TabButton active={activeTab === ALL_TAB} onClick={() => setActiveTab(ALL_TAB)}>
            全部
          </TabButton>
          {categories.map((category) => (
            <TabButton
              key={category.id}
              active={activeTab === category.id}
              onClick={() => setActiveTab(category.id)}
            >
              {category.name}
            </TabButton>
          ))}
        </div>

        {/* 搜尋 + 顯示已完成 */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜尋名稱 / 說明 / 備註…"
            className={`${INPUT_CLASS} flex-1`}
          />
          <label className="flex shrink-0 items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
            />
            顯示已完成
          </label>
        </div>

        <ErrorBanner message={errorMessage} />

        {tasksLoading ? (
          <CenteredSpinner />
        ) : visibleTasks.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">沒有符合條件的業務。</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visibleTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                categoryLabel={categoryName(task.categoryId)}
                onClick={() => navigate(`/tasks/${task.id}`)}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** 屬性頁籤按鈕。 */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

/** 單筆業務列。 */
function TaskRow({
  task,
  categoryLabel,
  onClick,
}: {
  task: Task;
  categoryLabel: string;
  onClick: () => void;
}) {
  const done = isDone(task);
  const overdue = isOverdue(task);
  const pendingCount = task.checklistItems.filter((item) => !item.done).length;
  const latestProgress = sortProgressEntries(task.progressEntries)[0];

  return (
    <li>
      <button onClick={onClick} className="w-full py-3 text-left hover:bg-slate-50">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800">{task.title}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {categoryLabel}
          </span>
          {done && <Badge tone="green">已完成</Badge>}
          {!done && pendingCount > 0 && <Badge tone="blue">待辦 {pendingCount}</Badge>}
          {task.recurrence && (
            <span
              className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700"
              title={describeRecurrence(task.recurrence)}
            >
              定期 · {describeRecurrence(task.recurrence)}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          {task.deadline ? (
            <span className={overdue ? 'font-semibold text-red-600' : ''}>
              期限：{task.deadline}
              {overdue && '（已逾期）'}
            </span>
          ) : (
            <span>無期限</span>
          )}
          {latestProgress && (
            <span className="truncate">
              最新進度：{latestProgress.date} {latestProgress.content}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}
