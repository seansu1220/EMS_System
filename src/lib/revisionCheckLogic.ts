/**
 * 「立即比對」的狀態判斷（純函式，不依賴 React）。
 */
import type { RevisionCheckControl, RevisionCheckPhase } from '../types/revisionCheck';

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
export function revisionCheckPhase(control: RevisionCheckControl | null): RevisionCheckPhase {
  const requestedAt = control ? toMillis(control.requestedAt) : null;
  if (!control || requestedAt === null) return 'idle';
  const handledAt = toMillis(control.handledRequestAt);
  if (handledAt === null || requestedAt > handledAt) return 'waiting';
  return control.status === 'running' ? 'running' : 'done';
}
