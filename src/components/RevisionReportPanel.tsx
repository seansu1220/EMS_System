/**
 * 「比對與匯出」分頁的「匯出解鎖修改紀錄」面板（v1.38 起，**只有管理員看得到**，使用者 2026-11-03 指定）。
 *
 * 選期間（預設上個月，可調到日）按「匯出」→ 救護科電腦的監看程式下一輪就在**那台電腦上**產出 Excel：
 * 未結案的案件、已結案每一件的修改內容（原內容 → 修改後）與申請事由。
 * 報表含病患資料，**只存在救護科電腦、不上雲**（使用者選定只做電腦端完整版），所以網頁沒有下載，
 * 只顯示檔名與件數。階段判斷與期間計算在 `lib/revisionCheckLogic`，這裡只負責顯示與按鈕。
 */
import { useEffect, useState } from 'react';
import { requestRevisionReport, subscribeRevisionReport } from '../services/revisionCheckService';
import {
  controlPhase,
  formatMoment,
  isControlBusy,
  previousMonthRange,
  validateDateRange,
} from '../lib/revisionCheckLogic';
import { UNLOCK_WATCH_POLL_SECONDS } from '../config/constants';
import type { AppUser } from '../types/user';
import type { DateRange, RevisionReportControl } from '../types/revisionCheck';
import { Button, Card, ErrorBanner, INPUT_CLASS } from './ui';

/** 報表在救護科電腦上的位置（給人找檔案用）。 */
const REPORT_FOLDER = 'tools\\ems-report\\out\\internal\\解鎖修改紀錄\\';

/** 目前狀態的一句話。 */
function describeReport(control: RevisionReportControl | null): string {
  const phase = controlPhase(control);
  if (phase === 'idle' || !control) return '還沒匯出過。';
  const period = `${control.rangeStart} ~ ${control.rangeEnd}`;
  if (phase === 'waiting') {
    return `已送出 ${period}（${formatMoment(control.requestedAt)}），等救護科電腦的監看程式接手；`
      + `監看開著的話約 ${UNLOCK_WATCH_POLL_SECONDS} 秒內會開始，一直沒動靜代表監看沒開。`;
  }
  if (phase === 'running') return `產出中：${period}（${formatMoment(control.startedAt)} 開始）…`;
  if (phase === 'failed') return `${period} 沒有產出：${control.errorMessage || '原因請看救護科電腦的監看視窗'}`;
  return `${formatMoment(control.finishedAt)} 已在救護科電腦產出「${control.fileName}」：`
    + `未結案 ${control.openCount ?? 0} 件、已結案 ${control.closedCount ?? 0} 件`
    + `（有改動 ${control.changedCount ?? 0} 件）。`;
}

export function RevisionReportPanel({ user }: { user: AppUser }) {
  const [control, setControl] = useState<RevisionReportControl | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [range, setRange] = useState<DateRange>(() => previousMonthRange(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeRevisionReport(
        (next) => {
          setControl(next);
          setLoaded(true);
          setError(null);
        },
        (subscribeError) => setError(subscribeError.message),
      ),
    [],
  );

  async function handleExport() {
    const rangeError = validateDateRange(range);
    if (rangeError) {
      setError(rangeError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestRevisionReport(user, range);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const phase = controlPhase(control);

  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-slate-800">匯出解鎖修改紀錄</h2>
        <p className="mt-1 text-xs text-slate-500">
          依解鎖時間挑出期間內的案件，列出：未結案的是哪幾件、已結案的每一件改了哪裡（原內容 → 修改後）、申請事由。
          檔案含病患資料，只會產生在救護科電腦的 {REPORT_FOLDER}，網頁不提供下載。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          className={`${INPUT_CLASS} w-auto`}
          value={range.start}
          disabled={busy}
          onChange={(event) => setRange((current) => ({ ...current, start: event.target.value }))}
          aria-label="起日"
        />
        <span className="text-sm text-slate-500">至</span>
        <input
          type="date"
          className={`${INPUT_CLASS} w-auto`}
          value={range.end}
          disabled={busy}
          onChange={(event) => setRange((current) => ({ ...current, end: event.target.value }))}
          aria-label="迄日"
        />
        <Button variant="secondary" disabled={busy} onClick={() => setRange(previousMonthRange(new Date()))}>
          上個月
        </Button>
        <Button disabled={!loaded || busy || isControlBusy(control)} onClick={handleExport}>
          {busy ? '送出中…' : '匯出'}
        </Button>
      </div>

      <p className={`text-sm ${phase === 'failed' ? 'text-red-600' : 'text-slate-700'}`}>
        {loaded ? describeReport(control) : '讀取中…'}
      </p>
      <ErrorBanner message={error} />
    </Card>
  );
}
