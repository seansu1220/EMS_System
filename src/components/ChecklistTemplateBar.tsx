/**
 * 待辦公版工具列（業務詳情頁的待辦區塊上方）。
 * - 套用公版：把選定公版的項目附加到目前業務的待辦清單末端（期限留空，之後個別編輯）。
 * - 另存為公版：把目前業務的待辦內容（依流程順序）存成新公版，供其他業務重複使用。
 * 純 UI + 事件捕捉；資料存取委由 checklistTemplateService / taskService。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useChecklistTemplates } from '../hooks/useChecklistTemplates';
import { createChecklistTemplate } from '../services/checklistTemplateService';
import { appendChecklistFromTemplate, extractChecklistContents } from '../services/taskService';
import type { Task } from '../types/task';
import { Button, ErrorBanner, INPUT_CLASS } from './ui';

interface ChecklistTemplateBarProps {
  task: Task;
}

export function ChecklistTemplateBar({ task }: ChecklistTemplateBarProps) {
  const { user } = useAuth();
  const { templates, loading, error: loadError } = useChecklistTemplates();

  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingAsTemplate, setSavingAsTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');

  /** 套用選定公版：二次確認後把項目附加到現有待辦之後。 */
  async function handleApply() {
    const template = templates.find((item) => item.id === selectedId);
    if (!template) {
      setError('請先選擇要套用的公版。');
      return;
    }
    if (!window.confirm(`確定套用公版「${template.name}」？將新增 ${template.items.length} 筆待辦（期限留空）。`)) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await appendChecklistFromTemplate(task, template);
      setSelectedId('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** 另存為公版：以目前待辦內容（含已勾選項目）建立新公版。 */
  async function handleSaveAsTemplate() {
    const name = newTemplateName.trim();
    if (!name) {
      setError('請輸入公版名稱。');
      return;
    }
    if (templates.some((item) => item.name.trim().toLowerCase() === name.toLowerCase())) {
      setError('已有相同名稱的公版。');
      return;
    }
    const contents = extractChecklistContents(task);
    if (contents.length === 0) {
      setError('目前沒有待辦事項可存成公版。');
      return;
    }
    if (!user) {
      setError('尚未登入，無法建立公版。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 建立者記為目前登入者（安全規則要求 ownerUid 等於自己）。
      await createChecklistTemplate(name, contents, user.uid);
      setSavingAsTemplate(false);
      setNewTemplateName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className={`${INPUT_CLASS} bg-white sm:flex-1`}
          disabled={loading || templates.length === 0}
        >
          <option value="">
            {loading
              ? '載入公版中…'
              : templates.length === 0
                ? '尚無待辦公版'
                : '選擇待辦公版…'}
          </option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}（{template.items.length} 項）
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <Button
            type="button"
            className="px-3 py-1.5 text-xs"
            onClick={handleApply}
            disabled={saving || !selectedId}
          >
            套用公版
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-3 py-1.5 text-xs"
            onClick={() => {
              setSavingAsTemplate((prev) => !prev);
              setNewTemplateName('');
              setError(null);
            }}
            disabled={saving}
          >
            另存為公版
          </Button>
        </div>
      </div>

      {savingAsTemplate && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            placeholder="公版名稱，例如：標案標準流程"
            className={`${INPUT_CLASS} bg-white sm:flex-1`}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveAsTemplate();
            }}
          />
          <Button
            type="button"
            className="px-3 py-1.5 text-xs"
            onClick={handleSaveAsTemplate}
            disabled={saving}
          >
            {saving ? '儲存中…' : '儲存公版'}
          </Button>
        </div>
      )}

      <p className="text-xs text-slate-400">
        公版只保存項目內容與順序（不含期限）；可到
        <Link to="/templates" className="mx-1 text-slate-600 underline">
          待辦公版
        </Link>
        頁面編輯或刪除。
      </p>

      <ErrorBanner message={error ?? loadError} />
    </div>
  );
}
