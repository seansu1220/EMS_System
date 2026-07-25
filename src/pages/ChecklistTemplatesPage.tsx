/**
 * 待辦公版管理頁。
 * 可新增公版、改名、刪除，並管理公版底下的項目（新增/改內容/刪除/拖曳排序）。
 * 公版只保存項目內容與順序；期限於套用到業務後再個別設定。
 */
import { useEffect, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../hooks/useAuth';
import { useChecklistTemplates } from '../hooks/useChecklistTemplates';
import {
  createChecklistTemplate,
  deleteChecklistTemplate,
  renameChecklistTemplate,
  updateChecklistTemplateItems,
} from '../services/checklistTemplateService';
import type { ChecklistTemplate, ChecklistTemplateItem } from '../types/checklistTemplate';
import { Button, Card, CenteredSpinner, ErrorBanner, INPUT_CLASS } from '../components/ui';

export function ChecklistTemplatesPage() {
  const { user, isAdmin: canDelete } = useAuth();
  const { templates, loading, error: loadError } = useChecklistTemplates();

  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 新增空白公版（項目於卡片內再逐筆加入）。 */
  async function handleCreate() {
    if (!user) return;
    const name = newName.trim();
    if (!name) {
      setError('請輸入公版名稱。');
      return;
    }
    if (templates.some((item) => item.name.trim().toLowerCase() === name.toLowerCase())) {
      setError('已有相同名稱的公版。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createChecklistTemplate(name, [], user.uid);
      setNewName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">待辦公版</h1>
        <p className="mt-1 text-sm text-slate-500">
          把常做的流程（例如標案的各關卡）存成公版，新增業務或既有業務都能一鍵帶入成待辦事項。
        </p>
      </div>
      <ErrorBanner message={error ?? loadError} />

      <Card>
        <h2 className="mb-3 text-base font-bold text-slate-700">新增公版</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="公版名稱，例如：標案標準流程"
            className={`${INPUT_CLASS} flex-1`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
            }}
          />
          <Button onClick={handleCreate} disabled={busy}>
            新增
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          也可以在業務詳情頁的待辦區塊用「另存為公版」，直接把現有待辦存成公版。
        </p>
      </Card>

      {loading ? (
        <CenteredSpinner />
      ) : templates.length === 0 ? (
        <p className="text-sm text-slate-400">尚無待辦公版。</p>
      ) : (
        templates.map((template) => (
          <TemplateCard key={template.id} template={template} canDelete={canDelete} />
        ))
      )}
    </div>
  );
}

/**
 * 單張公版卡片：改名、刪除（僅管理員）、項目管理（新增/改內容/刪除/拖曳排序）。
 * @param canDelete 是否顯示「刪除公版」按鈕（僅管理員）
 */
function TemplateCard({
  template,
  canDelete,
}: {
  template: ChecklistTemplate;
  canDelete: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(template.name);
  const [newItemContent, setNewItemContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 本地項目順序：拖曳時樂觀更新，避免等待 Firestore 回波。
  const [items, setItems] = useState<ChecklistTemplateItem[]>(template.items);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (isDragging || busy) return;
    setItems(template.items);
  }, [template.items, isDragging, busy]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  /** 以整份項目陣列覆寫（新增/改內容/刪除/排序共用）；失敗時還原本地順序。 */
  async function saveItems(next: ChecklistTemplateItem[]) {
    setItems(next); // 樂觀更新
    setBusy(true);
    setError(null);
    try {
      await updateChecklistTemplateItems(template.id, next);
    } catch (err) {
      setError((err as Error).message);
      setItems(template.items);
    } finally {
      setBusy(false);
    }
  }

  async function handleRename() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('公版名稱不可為空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameChecklistTemplate(template.id, trimmed);
      setRenaming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteTemplate() {
    if (!window.confirm(`確定刪除公版「${template.name}」？已套用到業務上的待辦不受影響。`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteChecklistTemplate(template.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  function handleAddItem() {
    const content = newItemContent.trim();
    if (!content) {
      setError('請輸入項目內容。');
      return;
    }
    setNewItemContent('');
    void saveItems([
      ...items,
      { id: crypto.randomUUID(), content, sortOrder: items.length },
    ]);
  }

  function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((item) => item.id === active.id);
    const newIndex = items.findIndex((item) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    void saveItems(arrayMove(items, oldIndex, newIndex));
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${INPUT_CLASS} flex-1`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
              }}
            />
            <Button className="px-3 py-1.5 text-xs" onClick={handleRename} disabled={busy}>
              儲存
            </Button>
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-xs"
              onClick={() => {
                setRenaming(false);
                setName(template.name);
              }}
              disabled={busy}
            >
              取消
            </Button>
          </>
        ) : (
          <>
            <h2 className="flex-1 text-base font-bold text-slate-700">{template.name}</h2>
            <span className="text-xs text-slate-400">{items.length} 項</span>
            <button
              type="button"
              onClick={() => setRenaming(true)}
              className="rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
            >
              改名
            </button>
            {/* 刪除公版僅管理員可執行（Firestore 規則同樣會擋下一般使用者）。 */}
            {canDelete && (
              <button
                type="button"
                onClick={handleDeleteTemplate}
                className="rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50"
              >
                刪除
              </button>
            )}
          </>
        )}
      </div>

      <ErrorBanner message={error} />

      {items.length === 0 ? (
        <p className="text-sm text-slate-400">此公版尚無項目，請於下方新增。</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setIsDragging(true)}
          onDragCancel={() => setIsDragging(false)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {items.map((item, index) => (
                <SortableTemplateItemRow
                  key={item.id}
                  item={item}
                  index={index}
                  busy={busy}
                  onChangeContent={(content) =>
                    saveItems(items.map((each) => (each.id === item.id ? { ...each, content } : each)))
                  }
                  onRemove={() => saveItems(items.filter((each) => each.id !== item.id))}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newItemContent}
          onChange={(e) => setNewItemContent(e.target.value)}
          placeholder="新增項目，例如：簽陳核准"
          className={`${INPUT_CLASS} flex-1`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddItem();
          }}
        />
        <Button className="px-3 py-1.5 text-xs" onClick={handleAddItem} disabled={busy}>
          加入項目
        </Button>
      </div>
    </Card>
  );
}

/** 單列公版項目（可拖曳排序、就地改內容、刪除）。 */
function SortableTemplateItemRow({
  item,
  index,
  busy,
  onChangeContent,
  onRemove,
}: {
  item: ChecklistTemplateItem;
  index: number;
  busy: boolean;
  onChangeContent: (content: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(item.content);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  function handleSave() {
    const trimmed = content.trim();
    if (!trimmed) return;
    setEditing(false);
    onChangeContent(trimmed);
  }

  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-2 bg-white px-2 py-1">
      <button
        type="button"
        aria-label="拖曳排序"
        title="拖曳排序"
        {...attributes}
        {...listeners}
        className="flex h-10 w-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-lg text-lg text-slate-400 select-none hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
      >
        ⠿
      </button>
      <span className="w-6 shrink-0 text-center font-mono text-xs text-slate-400">{index + 1}</span>
      {editing ? (
        <>
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className={`${INPUT_CLASS} flex-1`}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
          <Button className="px-3 py-1.5 text-xs" onClick={handleSave} disabled={busy}>
            儲存
          </Button>
          <Button
            variant="secondary"
            className="px-3 py-1.5 text-xs"
            onClick={() => {
              setEditing(false);
              setContent(item.content);
            }}
            disabled={busy}
          >
            取消
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1 whitespace-pre-wrap text-sm text-slate-700">{item.content}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="shrink-0 text-xs text-slate-500 hover:underline"
          >
            編輯
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 text-xs text-red-500 hover:underline"
          >
            刪除
          </button>
        </>
      )}
    </li>
  );
}
