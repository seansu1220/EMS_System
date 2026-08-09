/**
 * 解鎖工單頁 `/unlock`：提出解鎖申請，並查看每一筆的處理結果。
 *
 * **這一頁不會真的去解鎖。** 目標系統每次登入都要驗證碼（本專案鐵則：由本人辨識、
 * 不自動破解），瀏覽器也無法跨網域操作那套 frameset 系統，因此網頁只負責
 * 「提出申請」與「查結果」，實際動手的是救護科電腦上的本機工具。
 *
 * 三種角色都能用；「解鎖專用」帳號只看得到自己送出的工單（安全規則同步限制）。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';
import {
  createUnlockRequests,
  deleteUnlockRequest,
  parseTemsisList,
  requeueUnlockRequest,
  subscribeUnlockRequests,
} from '../services/unlockRequestService';
import { canSeeAllUnlockRequests, isAdmin } from '../lib/permissions';
import {
  UNLOCK_REQUEST_MAX_BATCH,
  UNLOCK_RESULT_SUMMARY,
  UNLOCK_STATUS_LABELS,
} from '../config/constants';
import type { UnlockRequest } from '../types/unlockRequest';
import {
  Badge,
  Button,
  Card,
  CenteredSpinner,
  ErrorBanner,
  FieldLabel,
  INPUT_CLASS,
  TEXTAREA_CLASS,
} from '../components/ui';

/** 把 ISO 時間字串轉成畫面用的「MM/DD HH:mm」；空字串回傳破折號。 */
function formatMoment(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 一筆工單的結果欄。
 *
 * 申請人看到的是**一句話**加上案件日期與車輛（足夠確認是不是自己那件、現在能不能去改）。
 * 本機工具回寫的 `detail` 寫的是第幾張紀錄表、比對到哪個按鈕、畫面出現什麼訊息，
 * 那是維護時才用得到的東西，只給管理員看（使用者 2026-08-09 指定）；
 * 真要追整個過程，看執行電腦的 `out/watch.log` 比看這一欄清楚得多。
 */
function ResultCell({ request, showDetail }: { request: UnlockRequest; showDetail: boolean }) {
  const summary = UNLOCK_RESULT_SUMMARY[request.status] ?? '—';
  if (!request.result) return <span className="text-slate-400">{summary}</span>;

  const { caseDate, vehicle, squad, detail, processedAt, processedBy } = request.result;
  const vehicleText = vehicle ? `${vehicle}${squad ? `（${squad}）` : ''}` : squad ?? '';
  return (
    <div className="space-y-0.5">
      {(caseDate || vehicleText) && (
        <div className="font-medium text-slate-700">
          {caseDate ?? '日期讀不到'}
          {vehicleText && <span className="ml-2">{vehicleText}</span>}
        </div>
      )}
      <div className="text-slate-600">{summary}</div>
      {showDetail && detail && (
        <div className="mt-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500">
          <span className="mr-1 font-medium text-slate-400">執行細節</span>
          {detail}
        </div>
      )}
      <div className="text-xs text-slate-400">
        {formatMoment(processedAt)} 由 {processedBy || '（未記錄）'} 執行
      </div>
    </div>
  );
}

export function UnlockPage() {
  const { user } = useAuth();
  const seesAll = canSeeAllUnlockRequests(user);
  /** 管理員才看得到執行細節，也才動得了別人的工單（重新送單／刪除）。 */
  const canManage = isAdmin(user);

  const [requests, setRequests] = useState<UnlockRequest[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawTemsis, setRawTemsis] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  /** 正在處理中的那一列（避免連按，也讓按鈕在寫入期間停用）。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return undefined;
    return subscribeUnlockRequests(
      { uid: user.uid, onlyMine: !seesAll },
      (list) => {
        setRequests(list);
        setLoadError(null);
      },
      (error) => setLoadError(error.message),
    );
  }, [user, seesAll]);

  /** 目前輸入框裡有幾個編號（即時顯示，貼完就知道拆成幾筆）。 */
  const parsed = useMemo(() => parseTemsisList(rawTemsis), [rawTemsis]);
  const pendingCount = requests?.filter((item) => item.status === 'pending').length ?? 0;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    setSubmitError(null);
    setNotice('');
    setSubmitting(true);
    try {
      const count = await createUnlockRequests(user, parsed, reason);
      setRawTemsis('');
      setReason('');
      setNotice(`已送出 ${count} 筆工單，等救護科電腦執行。`);
    } catch (error) {
      setSubmitError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 管理員動作的共用外殼：先問過使用者，再執行，過程中鎖住那一列。
   *
   * 兩個動作（重新送單、刪除）差別只有確認語與要呼叫誰，其餘完全一樣，
   * 抽成一個函式才不會兩邊各寫一次錯誤處理。
   */
  async function runRowAction(
    request: UnlockRequest,
    confirmMessage: string,
    action: (requestId: string) => Promise<void>,
  ) {
    if (!window.confirm(confirmMessage)) return;
    setActionError(null);
    setNotice('');
    setBusyId(request.id);
    try {
      await action(request.id);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">解鎖救護紀錄表</h1>
        <p className="mt-1 text-sm text-slate-500">
          執行電腦有開啟就會自動偵測並解鎖。案件狀態若變為需人工處理，請通知救護科承辦人。
        </p>
      </div>

      <Card>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <FieldLabel required>TEMSIS 編號</FieldLabel>
            <textarea
              className={TEXTAREA_CLASS}
              rows={4}
              value={rawTemsis}
              onChange={(event) => setRawTemsis(event.target.value)}
              placeholder={'一行一個，也可以從 Excel 整欄複製貼上\n2026071210100310384101'}
            />
            <p className="mt-1 text-xs text-slate-400">
              {parsed.length > 0
                ? `這次會建立 ${parsed.length} 筆工單（重複的編號只留一筆）`
                : `一次最多 ${UNLOCK_REQUEST_MAX_BATCH} 筆`}
            </p>
          </div>

          <div>
            <FieldLabel required>申請事由</FieldLabel>
            <input
              className={INPUT_CLASS}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：到院前處置漏填，需補登"
            />
          </div>

          <ErrorBanner message={submitError} />
          {notice && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
              {notice}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting || parsed.length === 0 || reason.trim() === ''}>
              {submitting ? '送出中…' : '送出申請'}
            </Button>
            <span className="text-xs text-slate-400">
              送出後不需要等待，救護科的電腦會統一處理。
            </span>
          </div>
        </form>
      </Card>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-semibold text-slate-800">
            {seesAll ? '所有工單' : '我送出的工單'}
          </h2>
          {pendingCount > 0 && (
            <span className="text-sm text-amber-600">目前有 {pendingCount} 筆待處理</span>
          )}
        </div>

        <ErrorBanner message={loadError} />
        <ErrorBanner message={actionError} />
        {requests === null && !loadError && <CenteredSpinner />}
        {requests !== null && requests.length === 0 && (
          <Card>
            <p className="text-sm text-slate-500">還沒有任何工單。</p>
          </Card>
        )}

        {requests !== null && requests.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className={`w-full text-left text-sm ${canManage ? 'min-w-[54rem]' : 'min-w-[42rem]'}`}>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">狀態</th>
                  <th className="px-4 py-2 font-medium">TEMSIS</th>
                  <th className="px-4 py-2 font-medium">事由</th>
                  {seesAll && <th className="px-4 py-2 font-medium">申請人</th>}
                  <th className="px-4 py-2 font-medium">結果</th>
                  {canManage && <th className="px-4 py-2 font-medium">管理</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {requests.map((request) => {
                  const status = UNLOCK_STATUS_LABELS[request.status] ?? {
                    label: request.status,
                    tone: 'slate' as const,
                  };
                  return (
                    <tr key={request.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <div className="mt-1 text-xs text-slate-400">
                          {formatMoment(request.requestedAt)}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-700">
                        {request.temsis}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{request.reason}</td>
                      {seesAll && (
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {request.requestedByName}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <ResultCell request={request} showDetail={canManage} />
                      </td>
                      {canManage && (
                        <td className="whitespace-nowrap px-4 py-3">
                          <div className="flex gap-2">
                            <Button
                              variant="secondary"
                              className="px-2 py-1 text-xs"
                              disabled={busyId === request.id || request.status === 'pending'}
                              onClick={() =>
                                runRowAction(
                                  request,
                                  `確定把 ${request.temsis} 退回「待處理」重跑一次？`
                                    + '上一次的結果會清掉，救護科電腦下一輪就會再處理。',
                                  requeueUnlockRequest,
                                )
                              }
                            >
                              重新送單
                            </Button>
                            <Button
                              variant="danger"
                              className="px-2 py-1 text-xs"
                              disabled={busyId === request.id}
                              onClick={() =>
                                runRowAction(
                                  request,
                                  `確定刪除 ${request.temsis} 這張工單？此動作無法復原。`,
                                  deleteUnlockRequest,
                                )
                              }
                            >
                              刪除
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
