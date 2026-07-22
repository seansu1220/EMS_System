/**
 * 業務詳情 / 編輯 / 進度頁。
 * 訂閱單一業務即時更新；可編輯欄位、管理進度紀錄、刪除業務（二次確認）。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCategories } from '../hooks/useCategories';
import { deleteTask, subscribeTask, updateTask } from '../services/taskService';
import type { Task, TaskDraft } from '../types/task';
import { TaskForm } from '../components/TaskForm';
import { ProgressSection } from '../components/ProgressSection';
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
    await updateTask(task.id, draft, task.status);
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

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">業務詳情</h1>
        <Button variant="secondary" onClick={() => navigate('/')}>
          回首頁
        </Button>
      </div>

      <ErrorBanner message={error} />

      <Card>
        <h2 className="mb-4 text-base font-bold text-slate-700">編輯業務</h2>
        <TaskForm
          categories={categories}
          initial={{
            title: task.title,
            categoryId: task.categoryId,
            description: task.description,
            deadline: task.deadline,
            priority: task.priority,
            status: task.status,
            note: task.note,
          }}
          onSubmit={handleSave}
          onCancel={() => navigate('/')}
          submitLabel="儲存變更"
        />
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-bold text-slate-700">進度紀錄</h2>
        <ProgressSection task={task} />
      </Card>

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
    </div>
  );
}
