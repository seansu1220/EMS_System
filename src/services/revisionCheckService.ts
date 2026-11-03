/**
 * 管理員給本機監看的請求（立即比對 v1.37、匯出解鎖修改紀錄 v1.38）的讀寫。不依賴 React。
 *
 * 每種請求只有一份文件 `unlockControl/{revisionCheck|revisionReport}`。權限由 Firestore Security Rules 強制：
 * - 只有管理員送得出請求（使用者 2026-11-03 指定：按鈕只有管理員看得到）
 * - 本機監看（一般使用者身分的程式帳號）只能回寫處理狀態，動不了請求欄位
 */
import { doc, onSnapshot, serverTimestamp, setDoc, type DocumentData } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import type { AppUser } from '../types/user';
import type {
  ControlBase,
  ControlStatus,
  DateRange,
  RevisionCheckControl,
  RevisionReportControl,
} from '../types/revisionCheck';

/** 文件 ID（每種只有一份）。 */
const REVISION_CHECK_DOC_ID = 'revisionCheck';
const REVISION_REPORT_DOC_ID = 'revisionReport';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 數字欄位；不是數字一律 null。 */
function toCount(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** 兩種請求共同的欄位。 */
function toControlBase(stored: DocumentData): ControlBase {
  const status: ControlStatus = ['running', 'done', 'failed'].includes(stored.status) ? stored.status : '';
  return {
    requestedAt: toIso(stored.requestedAt),
    requestedByName: stored.requestedByName ?? '',
    handledRequestAt: toIso(stored.handledRequestAt),
    status,
    startedAt: toIso(stored.startedAt),
    finishedAt: toIso(stored.finishedAt),
  };
}

/** 訂閱一份控制文件（即時更新：監看一接手，畫面就跟著變）；還沒有人按過時收到 null。 */
function subscribeControl<T>(
  docId: string,
  toControl: (stored: DocumentData) => T,
  onData: (control: T | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COLLECTIONS.unlockControl, docId),
    (snapshot) => {
      if (!snapshot.exists()) {
        onData(null);
        return;
      }
      // 剛按下去、伺服器時間還沒回來時用估計值，畫面才能馬上顯示「已送出」。
      onData(toControl(snapshot.data({ serverTimestamps: 'estimate' })));
    },
    (error) => onError(new Error(`讀取 ${docId} 狀態失敗（revisionCheckService.subscribeControl）：${error.message}`)),
  );
}

/** 送出請求（只動請求欄位，監看寫回的狀態保留）。 */
async function sendControlRequest(docId: string, user: AppUser, extra: Record<string, string> = {}): Promise<void> {
  try {
    await setDoc(
      doc(db, COLLECTIONS.unlockControl, docId),
      {
        requestedAt: serverTimestamp(),
        requestedBy: user.uid,
        requestedByName: user.displayName || user.email,
        ...extra,
      },
      { merge: true },
    );
  } catch (error) {
    throw new Error(`送出 ${docId} 請求失敗（revisionCheckService.sendControlRequest）：${(error as Error).message}`);
  }
}

/** 訂閱「立即比對」的狀態。 */
export function subscribeRevisionCheck(
  onData: (control: RevisionCheckControl | null) => void,
  onError: (error: Error) => void,
): () => void {
  return subscribeControl(
    REVISION_CHECK_DOC_ID,
    (stored) => ({
      ...toControlBase(stored),
      checkedCount: toCount(stored.checkedCount),
      comparedCount: toCount(stored.comparedCount),
    }),
    onData,
    onError,
  );
}

/**
 * 送出「立即比對」請求。
 * @throws 寫入失敗時（含權限不足）
 */
export function requestRevisionCheck(user: AppUser): Promise<void> {
  return sendControlRequest(REVISION_CHECK_DOC_ID, user);
}

/** 訂閱「匯出解鎖修改紀錄」的狀態。 */
export function subscribeRevisionReport(
  onData: (control: RevisionReportControl | null) => void,
  onError: (error: Error) => void,
): () => void {
  return subscribeControl(
    REVISION_REPORT_DOC_ID,
    (stored) => ({
      ...toControlBase(stored),
      rangeStart: stored.rangeStart ?? '',
      rangeEnd: stored.rangeEnd ?? '',
      fileName: stored.fileName ?? '',
      openCount: toCount(stored.openCount),
      closedCount: toCount(stored.closedCount),
      changedCount: toCount(stored.changedCount),
      errorMessage: stored.errorMessage ?? '',
    }),
    onData,
    onError,
  );
}

/**
 * 送出「匯出解鎖修改紀錄」請求（救護科電腦的監看程式下一輪就在本機產出 Excel）。
 * @throws 寫入失敗時（含權限不足、日期區間不合法）
 */
export function requestRevisionReport(user: AppUser, range: DateRange): Promise<void> {
  return sendControlRequest(REVISION_REPORT_DOC_ID, user, { rangeStart: range.start, rangeEnd: range.end });
}
