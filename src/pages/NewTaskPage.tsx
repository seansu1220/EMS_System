/** 新增業務頁。 */
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useCategories } from '../hooks/useCategories';
import { createTask } from '../services/taskService';
import type { TaskDraft } from '../types/task';
import { TaskForm } from '../components/TaskForm';
import { Card, CenteredSpinner, ErrorBanner } from '../components/ui';

export function NewTaskPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { categories, loading, error } = useCategories();

  async function handleSubmit(draft: TaskDraft) {
    if (!user) throw new Error('尚未登入，無法新增業務。');
    const id = await createTask(draft, user.uid);
    navigate(`/tasks/${id}`, { replace: true });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-bold text-slate-800">新增業務</h1>
      <ErrorBanner message={error} />
      <Card>
        {loading ? (
          <CenteredSpinner />
        ) : (
          <TaskForm
            categories={categories}
            onSubmit={handleSubmit}
            onCancel={() => navigate('/')}
            submitLabel="建立業務"
          />
        )}
      </Card>
    </div>
  );
}
