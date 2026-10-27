/**
 * PDF 工作區左側的直式工具列（手機寬度時改成橫排）：
 * 標記工具（瀏覽／塗黑／馬賽克／螢光筆＋顏色）、頁面動作（左轉、右轉、刪除）、復原上一步。
 * 頁面動作套用到「勾選的頁」，沒勾選時套用到大圖上的那一頁。
 */
import type { ReactNode } from 'react';
import { PDF_EDIT_CONFIG, PDF_EDIT_TOOLS } from '../../config/pdfTools';
import type { EditTool } from '../../types/pdfTools';

function ToolButton({
  label,
  icon,
  active = false,
  danger = false,
  disabled = false,
  role,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  role?: 'radio';
  onClick: () => void;
}) {
  const tone = active
    ? 'border-slate-800 bg-slate-800 text-white'
    : danger
      ? 'border-slate-200 bg-white text-red-600 hover:bg-red-50'
      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100';
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'radio' ? active : undefined}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-16 flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 text-[11px] font-medium leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${tone}`}
    >
      <span className="text-base leading-none">{icon}</span>
      {label}
    </button>
  );
}

export function WorkspaceToolbar({
  tool,
  highlightColor,
  targetLabel,
  canAct,
  canUndo,
  onToolChange,
  onColorChange,
  onRotate,
  onRemove,
  onUndo,
}: {
  tool: EditTool;
  highlightColor: string;
  /** 頁面動作會套用到哪些頁的說明，例如「目前這頁」「勾選的 3 頁」。 */
  targetLabel: string;
  canAct: boolean;
  canUndo: boolean;
  onToolChange: (tool: EditTool) => void;
  onColorChange: (color: string) => void;
  onRotate: (delta: number) => void;
  onRemove: () => void;
  onUndo: () => void;
}) {
  return (
    <div data-ws="toolbar" className="flex shrink-0 flex-wrap items-start gap-1.5 md:w-[72px] md:flex-col md:flex-nowrap md:items-center">
      <div className="flex flex-wrap gap-1.5 md:flex-col" role="radiogroup" aria-label="標記工具">
        {PDF_EDIT_TOOLS.map((item) => (
          <ToolButton
            key={item.key}
            role="radio"
            label={item.name}
            icon={item.icon}
            active={tool === item.key}
            onClick={() => onToolChange(item.key)}
          />
        ))}
      </div>
      {tool === 'highlight' && (
        <div className="flex gap-1 md:grid md:grid-cols-2" aria-label="螢光筆顏色">
          {PDF_EDIT_CONFIG.highlightColors.map((color) => (
            <button
              key={color.value}
              type="button"
              title={color.name}
              aria-label={`螢光筆顏色：${color.name}`}
              aria-pressed={highlightColor === color.value}
              onClick={() => onColorChange(color.value)}
              className={`h-6 w-6 rounded-full border-2 ${highlightColor === color.value ? 'border-slate-800' : 'border-white shadow'}`}
              style={{ backgroundColor: color.value }}
            />
          ))}
        </div>
      )}
      <div className="hidden h-px w-full bg-slate-200 md:block" />
      <div className="flex flex-wrap gap-1.5 md:flex-col">
        <ToolButton label="向左轉 90°" icon="⟲" disabled={!canAct} onClick={() => onRotate(-90)} />
        <ToolButton label="向右轉 90°" icon="⟳" disabled={!canAct} onClick={() => onRotate(90)} />
        <ToolButton label="刪除頁面" icon="🗑" danger disabled={!canAct} onClick={onRemove} />
        <ToolButton label="復原上一步" icon="↶" disabled={!canUndo} onClick={onUndo} />
      </div>
      <p className="w-full text-center text-[11px] leading-tight text-slate-500 md:w-16" aria-live="polite">
        套用到：{targetLabel}
      </p>
    </div>
  );
}
