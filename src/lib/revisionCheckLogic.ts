/**
 * 「立即比對」「匯出解鎖修改紀錄」的狀態判斷與期間計算（純函式，不依賴 React）。
 */
import type { ControlBase, ControlPhase, DateRange } from '../types/revisionCheck';

/** ISO 字串 → 毫秒；空字串或不合法回傳 null。 */
function toMillis(iso: string): number | null {
  if (!iso) return null;
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? null : millis;
}

/**
 * 目前在哪個階段。
 *
 * 請求時間比監看認領過的還新＝還沒接手。
 * ⚠️ 判斷法須與 `tools/ems-report/unlockQueue.mjs` 的 `isRevisionCheckPending()` 一致。
 */
export function controlPhase(control: ControlBase | null): ControlPhase {
  const requestedAt = control ? toMillis(control.requestedAt) : null;
  if (!control || requestedAt === null) return 'idle';
  const handledAt = toMillis(control.handledRequestAt);
  if (handledAt === null || requestedAt > handledAt) return 'waiting';
  if (control.status === 'running') return 'running';
  return control.status === 'failed' ? 'failed' : 'done';
}

/** 是否正在等監看或處理中（這時按鈕停用，免得連按）。 */
export function isControlBusy(control: ControlBase | null): boolean {
  const phase = controlPhase(control);
  return phase === 'waiting' || phase === 'running';
}

/** 把 ISO 時間字串轉成「MM/DD HH:mm」；空字串回傳空字串。 */
export function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 本機日期 → `YYYY-MM-DD`。 */
function toDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 上個月的第一天到最後一天（每月初匯出的預設期間）。 */
export function previousMonthRange(today: Date): DateRange {
  const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
  return { start: toDateKey(firstDay), end: toDateKey(lastDay) };
}

/**
 * 檢查要匯出的期間；沒問題回傳 null，有問題回傳要給使用者看的一句話。
 * ⚠️ 規則須與 `firebase/firestore.rules` 的 `controlRequestValid()` 一致（格式、起日不晚於迄日）。
 */
export function validateDateRange(range: DateRange): string | null {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(range.start) || !pattern.test(range.end)) return '請選起日與迄日。';
  if (range.start > range.end) return '起日不能晚於迄日。';
  return null;
}
