/**
 * 業務詳情 / 編輯 / 進度 / 待辦 / 完成頁。
 * 訂閱單一業務即時更新；可編輯欄位、管理進度與待辦、標記完成/解除、刪除業務（二次確認）。
 * 業務完成後整筆鎖定：表單與進度/待辦不可修改、隱藏刪除，頂部顯示已完成橫幅。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCategories } from '../hooks/useCategories';
import { deleteTask, reopenTask, subscribeTask, updateTask } from '../services/taskService';
import type { Task, TaskDraft } from '../types/task';
import { TaskForm } from '../components/TaskForm';
import { ProgressSection } from '../components/ProgressSection';
import { ChecklistSection } from '../components/ChecklistSection';
import { CompletionSection } from '../components/CompletionSection';
import { Button, Card, CenteredSpinner, ErrorBanner } from '../components/ui';

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { categories } = useCategories();

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reopening, setReopening] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    setLoading(true);
    const unsubscribe = subscribeTask(
      taskId,
      (record) => {
        setTask(record);
        setNotFound(record === null);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [taskId]);

  async function handleSave(draft: TaskDraft) {
    if (!task) throw new Error('業務資料尚未載入。');
    await updateTask(task.id, draft);
  }

  async function handleDelete() {
    if (!task) return;
    if (!window.confirm(`確定刪除業務「${task.title}」？此動作無法復原。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteTask(task.id);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  }

  async function handleReopen() {
    if (!task) return;
    if (!window.confirm('確定解除完成？解除後業務恢復可編輯狀態。')) return;
    setReopening(true);
    setError(null);
    try {
      await reopenTask(task.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReopening(false);
    }
  }

  if (loading) return <CenteredSpinner />;
  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <ErrorBanner message="找不到這筆業務，可能已被刪除。" />
        <Button variant="secondary" onClick={() => navigate('/')}>
          回首頁
        </Button>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <ErrorBanner message={error} />
        <Button variant="secondary" onClick={() => navigate('/')}>
          回首頁
        </Button>
      </div>
    );
  }

  const locked = task.completed;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">業務詳情</h1>
        <Button variant="secondary" onClick={() => navigate('/')}>
          回首頁
        </Button>
      </div>

      <ErrorBanner message={error} />

      {locked && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-green-800">
                已完成
                {task.completionDate && (
                  <span className="ml-2 text-sm font-normal text-green-700">
                    完成日期：{task.completionDate}
                  </span>
                )}
              </p>
              {task.completionNote && (
                <p className="mt-1 whitespace-pre-wrap text-sm text-green-700">
                  {task.completionNote}
                </p>
              )}
              <p className="mt-2 text-xs text-green-600">
                此業務已鎖定，欄位與進度/待辦皆不可修改。
              </p>
            </div>
            <Button variant="secondary" onClick={handleReopen} disabled={reopening}>
              {reopening ? '處理中…' : '解除完成'}
            </Button>
          </div>
        </div>
      )}

      <Card>
        <h2 className="mb-4 text-base font-bold text-slate-700">
          {locked ? '業務內容' : '編輯業務'}
        </h2>
        <TaskForm
          categories={categories}
          ownerUid={task.ownerUid}
          initial={{
            title: task.title,
            categoryId: task.categoryId,
            description: task.description,
            deadline: task.deadline,
            note: task.note,
          }}
          onSubmit={handleSave}
          onCancel={() => navigate('/')}
          submitLabel="儲存變更"
          disabled={locked}
        />
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-bold text-slate-700">進度紀錄</h2>
        <ProgressSection task={task} locked={locked} />
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-bold text-slate-700">待辦事項</h2>
        <ChecklistSection task={task} locked={locked} />
      </Card>

      {!locked && (
        <Card>
          <h2 className="mb-1 text-base font-bold text-slate-700">完成業務</h2>
          <p className="mb-4 text-sm text-slate-500">標記完成後將鎖定此業務，可日後解除。</p>
          <CompletionSection task={task} />
        </Card>
      )}

      {!locked && (
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-700">刪除業務</h2>
              <p className="text-sm text-slate-500">刪除後無法復原，請謹慎操作。</p>
            </div>
            <Button variant="danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? '刪除中…' : '刪除業務'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
