/**
 * 新增業務頁。
 * 可選擇一個待辦公版，建立業務時自動帶入成為初始待辦事項（期限留空，之後個別編輯）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useCategories } from '../hooks/useCategories';
import { useChecklistTemplates } from '../hooks/useChecklistTemplates';
import { buildChecklistItemsFromTemplate, createTask } from '../services/taskService';
import type { TaskDraft } from '../types/task';
import { TaskForm } from '../components/TaskForm';
import { Card, CenteredSpinner, ErrorBanner, FieldLabel, INPUT_CLASS } from '../components/ui';

export function NewTaskPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { categories, loading, error } = useCategories();
  const { templates, error: templateError } = useChecklistTemplates();

  const [templateId, setTemplateId] = useState('');

  async function handleSubmit(draft: TaskDraft) {
    if (!user) throw new Error('尚未登入，無法新增業務。');
    const template = templates.find((item) => item.id === templateId);
    const checklistItems = template ? buildChecklistItemsFromTemplate(template.items) : [];
    const id = await createTask(draft, user.uid, checklistItems);
    navigate(`/tasks/${id}`, { replace: true });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-bold text-slate-800">新增業務</h1>
      <ErrorBanner message={error ?? templateError} />

      {templates.length > 0 && (
        <Card>
          <FieldLabel optional>待辦公版</FieldLabel>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">不套用公版</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}（{template.items.length} 項）
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-slate-400">
            建立業務時會自動帶入此公版的待辦項目；期限留空，建立後可於業務詳情頁個別設定。
          </p>
        </Card>
      )}

      <Card>
        {loading ? (
          <CenteredSpinner />
        ) : (
          <TaskForm
            categories={categories}
            ownerUid={user?.uid ?? ''}
            onSubmit={handleSubmit}
            onCancel={() => navigate('/')}
            submitLabel="建立業務"
          />
        )}
      </Card>
    </div>
  );
}
