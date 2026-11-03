/**
 * 解鎖工單頁的「立即比對」面板（v1.37 起，**只有管理員看得到**，使用者 2026-11-03 指定）。
 *
 * 平常救護科電腦的監看程式只在開啟時與每天半夜確認一次「解鎖過的案件結案了沒」；
 * 按這裡就叫它下一輪（約 20 秒內）馬上做一次。階段判斷在 `lib/revisionCheckLogic`，
 * 這裡只負責顯示與按鈕。
 */
import { useEffect, useState } from 'react';
import { requestRevisionCheck, subscribeRevisionCheck } from '../services/revisionCheckService';
import { revisionCheckPhase } from '../lib/revisionCheckLogic';
import { UNLOCK_WATCH_POLL_SECONDS } from '../config/constants';
import type { AppUser } from '../types/user';
import type { RevisionCheckControl } from '../types/revisionCheck';
import { Button, Card, ErrorBanner } from './ui';

/** 把 ISO 時間字串轉成「MM/DD HH:mm」；空字串回傳空字串。 */
function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 目前狀態的一句話。 */
function describeControl(control: RevisionCheckControl | null): string {
  const phase = revisionCheckPhase(control);
  if (phase === 'idle' || !control) return '還沒按過。';
  if (phase === 'waiting') {
    return `已送出（${formatMoment(control.requestedAt)}），等救護科電腦的監看程式接手；`
      + `監看開著的話約 ${UNLOCK_WATCH_POLL_SECONDS} 秒內會開始，一直沒動靜代表監看沒開。`;
  }
  if (phase === 'running') return `比對中（${formatMoment(control.startedAt)} 開始）…`;
  const counts = control.checkedCount === null
    ? ''
    : `：確認 ${control.checkedCount} 件，其中 ${control.comparedCount ?? 0} 件已結案並比對完成`;
  return `上次比對 ${formatMoment(control.finishedAt)} 完成${counts}。結果寫在各工單的比對欄。`;
}

export function RevisionCheckPanel({ user }: { user: AppUser }) {
  const [control, setControl] = useState<RevisionCheckControl | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeRevisionCheck(
        (next) => {
          setControl(next);
          setLoaded(true);
          setError(null);
        },
        (subscribeError) => setError(subscribeError.message),
      ),
    [],
  );

  const phase = revisionCheckPhase(control);

  async function handleRequest() {
    setBusy(true);
    setError(null);
    try {
      await requestRevisionCheck(user);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-slate-800">結案後比對</h2>
          <p className="mt-1 text-xs text-slate-500">
            平常監看程式只在開啟時與每天半夜確認一次解鎖過的案件結案了沒；按「立即比對」叫它現在就做。
          </p>
          <p className="mt-2 text-sm text-slate-700">{loaded ? describeControl(control) : '讀取中…'}</p>
        </div>
        <Button disabled={!loaded || busy || phase === 'waiting' || phase === 'running'} onClick={handleRequest}>
          {busy ? '送出中…' : '立即比對'}
        </Button>
      </div>
      <ErrorBanner message={error} />
    </Card>
  );
}
