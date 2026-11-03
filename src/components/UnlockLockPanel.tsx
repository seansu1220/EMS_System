/**
 * 解鎖工單頁的「鎖定時段」面板（v1.32 起，只有管理員與救護科管理者看得到）。
 *
 * 以月份為單位：鎖定到某個月＝那個月（含）以前的案件，任何人都不能再申請解鎖。
 * 判斷是否可以鎖、解鎖後退到哪個月都在 `lib/unlockLockLogic`，這裡只負責顯示與按鈕。
 */
import { useState } from 'react';
import { setLockedThroughMonth } from '../services/unlockPolicyService';
import {
  formatRocMonth,
  monthKeyOf,
  parseMonthKey,
  planLock,
  planUnlock,
  rocYearOptions,
  toMonthKey,
} from '../lib/unlockLockLogic';
import { ROC_YEAR_OFFSET, UNLOCK_LOCK_FIRST_ROC_YEAR } from '../config/constants';
import type { AppUser } from '../types/user';
import type { MonthKey, UnlockPolicy } from '../types/unlockPolicy';
import { Button, Card, ErrorBanner, INPUT_CLASS } from './ui';

const MONTH_OPTIONS = Array.from({ length: 12 }, (_unused, index) => index + 1);

/** 把 ISO 時間字串轉成「YYYY/MM/DD HH:mm」；空字串回傳空字串。 */
function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 目前鎖定狀態的一句話。 */
function describePolicy(policy: UnlockPolicy): string {
  if (policy.lockedThroughMonth === null) return '目前沒有鎖定任何時段，所有案件都可以申請解鎖。';
  return `目前鎖定：${formatRocMonth(policy.lockedThroughMonth)}（含）以前的救護紀錄表，不受理解鎖申請。`;
}

export function UnlockLockPanel({ user, policy }: { user: AppUser; policy: UnlockPolicy }) {
  const thisMonth = monthKeyOf(new Date());
  // 預設選在目前鎖定的月份（沒有鎖定時選這個月），鎖下一個月或解鎖都只要動一格。
  const initial = parseMonthKey(policy.lockedThroughMonth ?? thisMonth) ?? parseMonthKey(thisMonth);
  const [rocYear, setRocYear] = useState((initial?.year ?? 0) - ROC_YEAR_OFFSET);
  const [month, setMonth] = useState(initial?.month ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const chosen = toMonthKey(rocYear + ROC_YEAR_OFFSET, month);

  /** 確認後寫入新的鎖定範圍。 */
  async function applyChange(next: MonthKey | null, confirmMessage: string, doneMessage: string) {
    if (!window.confirm(confirmMessage)) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await setLockedThroughMonth(user, next);
      setNotice(doneMessage);
    } catch (changeError) {
      setError((changeError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleLock() {
    const plan = planLock(policy.lockedThroughMonth, chosen, thisMonth);
    if (!plan.ok) {
      setError(plan.message);
      return;
    }
    const label = formatRocMonth(plan.next);
    applyChange(
      plan.next,
      `確定鎖定 ${label}（含）以前的所有案件？鎖定後任何人都不能再申請這些案件的解鎖。`,
      `已鎖定 ${label}（含）以前的案件。`,
    );
  }

  function handleUnlock() {
    const plan = planUnlock(policy.lockedThroughMonth, chosen);
    if (!plan.ok) {
      setError(plan.message);
      return;
    }
    applyChange(
      plan.next,
      `確定從 ${formatRocMonth(chosen)}起開放申請解鎖？`
        + `${formatRocMonth(plan.next)}（含）以前的案件仍維持鎖定。`,
      `已開放 ${formatRocMonth(chosen)}起的案件，鎖定範圍改為 ${formatRocMonth(plan.next)}（含）以前。`,
    );
  }

  function handleClearAll() {
    applyChange(
      null,
      '確定解除全部鎖定？解除後任何月份的案件都可以申請解鎖。',
      '已解除全部鎖定。',
    );
  }

  const updatedAt = formatUpdatedAt(policy.updatedAt);

  return (
    <Card className="space-y-4 border-amber-200 bg-amber-50/40">
      <div>
        <h2 className="text-base font-semibold text-slate-800">鎖定時段（救護科管理者）</h2>
        <p className="mt-1 text-sm font-medium text-slate-700">{describePolicy(policy)}</p>
        <p className="mt-1 text-xs text-slate-500">
          {policy.isDefault
            ? '目前沿用系統預設值，還沒有人改過。'
            : `最後由 ${policy.updatedByName || '（未記錄）'} 於 ${updatedAt || '—'} 修改。`}
          {' '}以月份為單位，鎖定某個月＝那個月（含）以前全部鎖住；解鎖某個月＝那個月以後全部開放。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${INPUT_CLASS} w-auto`}
          value={rocYear}
          disabled={busy}
          onChange={(event) => setRocYear(Number(event.target.value))}
          aria-label="民國年"
        >
          {rocYearOptions(UNLOCK_LOCK_FIRST_ROC_YEAR, thisMonth).map((year) => (
            <option key={year} value={year}>
              {year} 年
            </option>
          ))}
        </select>
        <select
          className={`${INPUT_CLASS} w-auto`}
          value={month}
          disabled={busy}
          onChange={(event) => setMonth(Number(event.target.value))}
          aria-label="月份"
        >
          {MONTH_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value} 月
            </option>
          ))}
        </select>
        <Button disabled={busy} onClick={handleLock}>
          鎖定到這個月（含）
        </Button>
        <Button variant="secondary" disabled={busy || policy.lockedThroughMonth === null} onClick={handleUnlock}>
          從這個月起解鎖
        </Button>
        <Button
          variant="ghost"
          className="text-xs"
          disabled={busy || policy.lockedThroughMonth === null}
          onClick={handleClearAll}
        >
          全部解除
        </Button>
      </div>

      <ErrorBanner message={error} />
      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          {notice}
        </div>
      )}
    </Card>
  );
}
