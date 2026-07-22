/**
 * 共用 UI 基礎元件（純顯示，無業務邏輯）。
 * 統一樣式，供各頁面組合使用。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '../config/constants';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-slate-800 text-white hover:bg-slate-700 disabled:bg-slate-400',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}

/** 區塊卡片容器。 */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

/** 錯誤提示橫幅。 */
export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}

/** Badge 各色調樣式（對應 config 的 Tone）。 */
const BADGE_TONES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700',
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-blue-100 text-blue-700',
};

/** 狀態徽章。 */
export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

/** 載入中置中提示。 */
export function CenteredSpinner({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center text-slate-500">
      <span className="animate-pulse">{label}</span>
    </div>
  );
}

/** 表單欄位標籤（含選填提示）。 */
export function FieldLabel({
  children,
  required = false,
  optional = false,
}: {
  children: ReactNode;
  required?: boolean;
  optional?: boolean;
}) {
  return (
    <label className="mb-1 block text-sm font-medium text-slate-700">
      {children}
      {required && <span className="ml-0.5 text-red-500">*</span>}
      {optional && <span className="ml-1 text-xs text-slate-400">選填</span>}
    </label>
  );
}

/** 統一樣式的輸入框 class（供 input/select/textarea 共用）。 */
export const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';
