/**
 * 測試用傷票領取頁 `/triage-tags`：輸入單位與張數 → 系統接續發號 → 下載可直接雙面列印的 PDF。
 * 單位只能從月報表的分隊名單選，同一單位每週最多 20 張（台灣時間週一起算）。
 *
 * 三種角色都能用（含解鎖專用帳號）；解鎖專用帳號只看得到自己的領取紀錄。
 * 號碼一旦發出就不回收。「重新下載」**只給剛領的那一批**（按鈕在領取按鈕旁，離開頁面就消失）；
 * 領取紀錄不提供下載，免得後來登入的人把別人領的傷票載走（使用者 2026-09-21 指定）。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';
import {
  allocateTriageTags,
  subscribeTriageTagIssues,
  subscribeTriageTagNextSerial,
  subscribeTriageTagUnitUsage,
  validateTriageTagCount,
} from '../services/triageTagService';
import { canSeeAllTriageTagIssues } from '../lib/permissions';
import {
  describeTriageTagRange,
  describeTriageTagWeek,
  expandTriageTagRange,
  formatTriageTagNumber,
  remainingTriageTags,
  triageTagWeekIndex,
  triageTagWeeklyLimitFor,
  validateTriageTagUnit,
} from '../lib/triageTagNumber';
import {
  TRIAGE_TAG_ADMIN_UNIT,
  TRIAGE_TAG_BRIGADES,
  TRIAGE_TAG_MAX_PER_REQUEST,
  TRIAGE_TAG_TOTAL,
  TRIAGE_TAG_UNIT_HINT,
  TRIAGE_TAG_UNIT_WEEKLY_LIMIT,
  TRIAGE_TAG_UNITS,
} from '../config/triageTag';
import type { TriageTagIssue } from '../types/triageTag';
import { Button, Card, CenteredSpinner, ErrorBanner, FieldLabel, INPUT_CLASS } from '../components/ui';

/** 瀏覽器記住上次填的單位（同一台電腦通常是同一個分隊），不必每次重打。 */
const LAST_UNIT_STORAGE_KEY = 'triageTag.lastUnit';

function loadLastUnit(): string {
  try {
    const saved = window.localStorage.getItem(LAST_UNIT_STORAGE_KEY) ?? '';
    // 舊版允許自由輸入，存下來的可能不在名單上，這種就不要帶入。
    // 救護科只有管理員選得到，由畫面另外判斷，這裡一併放行。
    return TRIAGE_TAG_UNITS.includes(saved) || saved === TRIAGE_TAG_ADMIN_UNIT ? saved : '';
  } catch {
    return '';
  }
}

function saveLastUnit(unit: string): void {
  try {
    window.localStorage.setItem(LAST_UNIT_STORAGE_KEY, unit);
  } catch {
    // 無痕視窗等情況存不了，不影響領取。
  }
}

/** 把 ISO 時間字串轉成「YYYY/MM/DD HH:mm」；空字串回傳破折號。 */
function formatMoment(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 產生 PDF 並觸發下載。PDF 模組（含 jsPDF、QR code、條碼）很大，
 * 只有真的要下載時才載入，不拖慢其他頁面。
 */
async function downloadTriageTagPdf(
  startSerial: number,
  count: number,
  onProgress: (text: string) => void,
): Promise<void> {
  const { buildTriageTagPdf, triageTagPdfFileName } = await import('../lib/triageTagPdf');
  const tagNumbers = expandTriageTagRange(startSerial, count);
  const blob = await buildTriageTagPdf(tagNumbers, ({ donePages, totalPages }) =>
    onProgress(`產生 PDF 中… ${donePages} / ${totalPages} 頁`),
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = triageTagPdfFileName(tagNumbers);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 給瀏覽器一點時間開始下載再釋放。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 列印說明（照這樣印，正反面才會對齊）。 */
function PrintGuide() {
  return (
    <Card className="bg-slate-50">
      <h2 className="mb-2 font-semibold text-slate-700">列印方式</h2>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>一張 A4 印兩張傷票，PDF 是「正面、背面」交錯排好的。</li>
        <li>
          列印時選 <b>雙面列印 → 長邊翻轉</b>，縮放選 <b>實際大小（100%）</b>，不要選「符合頁面」。
        </li>
        <li>沿淺灰色虛線外框剪下，就是一張雙面傷票（左右兩張各自獨立）。</li>
      </ol>
    </Card>
  );
}

/** 領取紀錄表格（只列紀錄，**不提供下載**，避免別人把不是自己領的傷票載走）。 */
function IssueTable({ issues, showRequester }: { issues: TriageTagIssue[]; showRequester: boolean }) {
  if (issues.length === 0) return <p className="text-sm text-slate-400">還沒有領取紀錄。</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs text-slate-500">
          <tr>
            <th className="py-2 pr-3 font-medium">領取時間</th>
            <th className="py-2 pr-3 font-medium">單位</th>
            {showRequester && <th className="py-2 pr-3 font-medium">領取人</th>}
            <th className="py-2 pr-3 font-medium">號碼</th>
            <th className="py-2 pr-3 font-medium">張數</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.id} className="border-b border-slate-100 last:border-0">
              <td className="py-2 pr-3 whitespace-nowrap text-slate-500">{formatMoment(issue.requestedAt)}</td>
              <td className="py-2 pr-3 whitespace-nowrap">{issue.unit || '—'}</td>
              {showRequester && <td className="py-2 pr-3">{issue.requestedByName}</td>}
              <td className="py-2 pr-3 font-mono">{describeTriageTagRange(issue.startSerial, issue.count)}</td>
              <td className="py-2 pr-3">{issue.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TriageTagPage() {
  const { user, isAdmin: isAdminUser } = useAuth();
  const seesAll = canSeeAllTriageTagIssues(user);

  const [nextSerial, setNextSerial] = useState<number | null>(null);
  const [issues, setIssues] = useState<TriageTagIssue[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unitText, setUnitText] = useState(loadLastUnit);
  /**
   * 這次在本頁剛領到的那一批（給「重新下載」用）。只放在畫面的記憶體裡，
   * 離開或重新整理頁面就沒了——重新下載只給當下沒載到的人補救，不是隨時都能再載。
   */
  const [lastAllocation, setLastAllocation] = useState<{ startSerial: number; count: number } | null>(null);
  /** 單位本週已領張數；單位格式不對或還在讀取時為 null。 */
  const [unitUsed, setUnitUsed] = useState<number | null>(null);
  const [countText, setCountText] = useState('10');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => subscribeTriageTagNextSerial(setNextSerial, (error) => setLoadError(error.message)), []);

  useEffect(() => {
    if (!user) return undefined;
    return subscribeTriageTagIssues(
      { uid: user.uid, onlyMine: !seesAll },
      (list) => {
        setIssues(list);
        setLoadError(null);
      },
      (error) => setLoadError(error.message),
    );
  }, [user, seesAll]);

  const unit = unitText.trim();
  const unitProblem = validateTriageTagUnit(unit, isAdminUser);
  /** 這個單位每週上限；null＝不限（管理員的救護科）。 */
  const weeklyLimit = triageTagWeeklyLimitFor(unit);
  // 週序每次重新整理頁面才算一次；跨週時送出仍以送出當下為準（規則用伺服器時間核對）。
  const [weekIndex] = useState(() => triageTagWeekIndex(new Date()));

  useEffect(() => {
    setUnitUsed(null);
    if (unitProblem) return undefined;
    return subscribeTriageTagUnitUsage(unit, weekIndex, setUnitUsed, (error) => setLoadError(error.message));
  }, [unit, unitProblem, weekIndex]);

  const count = Number(countText);
  const countProblem =
    nextSerial === null || unitUsed === null ? null : validateTriageTagCount(count, nextSerial, unitUsed, weeklyLimit);
  const canSubmit = !busy && nextSerial !== null && unitProblem === null && unitUsed !== null && countProblem === null;

  /** 產 PDF 的共用外殼：鎖住按鈕、顯示進度、錯誤統一顯示。 */
  async function runDownload(startSerial: number, tagCount: number, doneMessage: string) {
    setProgress('準備中…');
    try {
      await downloadTriageTagPdf(startSerial, tagCount, setProgress);
      setNotice(doneMessage);
    } finally {
      setProgress('');
    }
  }

  async function handleAllocate(event: FormEvent) {
    event.preventDefault();
    if (!user || !canSubmit) return;
    setActionError(null);
    setNotice('');
    setBusy(true);
    try {
      const allocated = await allocateTriageTags(user, unit, count);
      // 號碼一領到就記下來：就算接下來產生 PDF 失敗，也能按「重新下載」補。
      setLastAllocation(allocated);
      saveLastUnit(unit);
      const range = describeTriageTagRange(allocated.startSerial, allocated.count);
      await runDownload(allocated.startSerial, allocated.count, `已領取 ${range}，PDF 已下載。`);
    } catch (error) {
      setActionError(
        `${(error as Error).message}　（若號碼已經領到但 PDF 沒下載成功，請按旁邊的「重新下載」。）`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRedownload() {
    if (!lastAllocation) return;
    setActionError(null);
    setNotice('');
    setBusy(true);
    try {
      const range = describeTriageTagRange(lastAllocation.startSerial, lastAllocation.count);
      await runDownload(lastAllocation.startSerial, lastAllocation.count, `已重新下載 ${range}（號碼不變）。`);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (nextSerial === null && !loadError) return <CenteredSpinner />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">測試用傷票領取</h1>
        <p className="mt-1 text-sm text-slate-500">
          選擇單位並輸入張數，系統會接續上一位同仁的號碼發給你，並產生可直接雙面列印的 PDF。
          同一單位每週最多 {TRIAGE_TAG_UNIT_WEEKLY_LIMIT} 張（每週一重新計算）。
        </p>
      </div>

      <ErrorBanner message={loadError} />

      <Card>
        <form className="space-y-4" onSubmit={handleAllocate}>
          <div className="max-w-xs">
            <FieldLabel required>單位</FieldLabel>
            <select className={INPUT_CLASS} value={unitText} onChange={(event) => setUnitText(event.target.value)}>
              <option value="">請選擇分隊</option>
              {/* 救護科只給管理員：不受每週上限（使用者 2026-09-21 指定）。 */}
              {isAdminUser && (
                <optgroup label="科內（管理員）">
                  <option value={TRIAGE_TAG_ADMIN_UNIT}>{TRIAGE_TAG_ADMIN_UNIT}（不限張數）</option>
                </optgroup>
              )}
              {TRIAGE_TAG_BRIGADES.map((brigade) => (
                <optgroup key={brigade.name} label={brigade.name}>
                  {brigade.squads.map((squad) => (
                    <option key={squad} value={squad}>
                      {squad}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {unit !== '' && unitProblem ? (
              <p className="mt-1 text-xs text-red-600">{unitProblem}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                {unit === '' || unitUsed === null
                  ? TRIAGE_TAG_UNIT_HINT
                  : weeklyLimit === null
                    ? `本週（${describeTriageTagWeek(weekIndex)}）${unit} 已領 ${unitUsed} 張，不限張數`
                    : `本週（${describeTriageTagWeek(weekIndex)}）${unit} 已領 ${unitUsed} / ${weeklyLimit} 張`}
              </p>
            )}
          </div>
          <div className="max-w-xs">
            <FieldLabel required>張數</FieldLabel>
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              max={weeklyLimit ?? TRIAGE_TAG_MAX_PER_REQUEST}
              value={countText}
              onChange={(event) => setCountText(event.target.value)}
            />
            <p className="mt-1 text-xs text-slate-400">
              {weeklyLimit === null
                ? `不限張數，但一次最多 ${TRIAGE_TAG_MAX_PER_REQUEST} 張（檔案太大瀏覽器會卡），要更多請分次領`
                : `同一單位每週最多 ${weeklyLimit} 張（一張 A4 印兩張）`}
            </p>
          </div>
          {nextSerial !== null && (
            <p className="text-sm text-slate-600">
              {remainingTriageTags(nextSerial) > 0 ? (
                <>
                  下一張從 <span className="font-mono font-semibold">{formatTriageTagNumber(nextSerial)}</span> 開始，
                  還剩 {remainingTriageTags(nextSerial).toLocaleString()} / {TRIAGE_TAG_TOTAL.toLocaleString()} 張可發。
                </>
              ) : (
                '號碼已全部發完。'
              )}
            </p>
          )}
          {countText !== '' && countProblem && <p className="text-sm text-red-600">{countProblem}</p>}
          <ErrorBanner message={actionError} />
          {notice && <p className="text-sm text-green-700">{notice}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!canSubmit}>
              {progress || '領取並下載 PDF'}
            </Button>
            {lastAllocation && (
              <Button type="button" variant="secondary" disabled={busy} onClick={handleRedownload}>
                重新下載（{describeTriageTagRange(lastAllocation.startSerial, lastAllocation.count)}）
              </Button>
            )}
          </div>
        </form>
      </Card>

      <PrintGuide />

      <Card>
        <h2 className="mb-3 font-semibold text-slate-700">{seesAll ? '所有人的領取紀錄' : '我的領取紀錄'}</h2>
        {issues === null ? (
          <p className="text-sm text-slate-400">載入中…</p>
        ) : (
          <IssueTable issues={issues} showRequester={seesAll} />
        )}
      </Card>
    </div>
  );
}
