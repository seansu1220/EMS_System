/**
 * 「立即比對」請求的讀寫（v1.37 起）。不依賴 React。
 *
 * 全系統只有一份文件 `unlockControl/revisionCheck`。權限由 Firestore Security Rules 強制：
 * - 只有管理員送得出請求（使用者 2026-11-03 指定：按鈕只有管理員看得到）
 * - 本機監看（一般使用者身分的程式帳號）只能回寫處理狀態，動不了請求欄位
 */
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import type { AppUser } from '../types/user';
import type { RevisionCheckControl, RevisionCheckStatus } from '../types/revisionCheck';

/** 文件 ID（只有這一份）。 */
const REVISION_CHECK_DOC_ID = 'revisionCheck';

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

/**
 * 訂閱「立即比對」的狀態（即時更新：監看一接手，畫面就跟著變）。
 *
 * @param onData 還沒有人按過時收到 null
 * @returns 取消訂閱函式
 */
export function subscribeRevisionCheck(
  onData: (control: RevisionCheckControl | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COLLECTIONS.unlockControl, REVISION_CHECK_DOC_ID),
    (snapshot) => {
      if (!snapshot.exists()) {
        onData(null);
        return;
      }
      // 剛按下去、伺服器時間還沒回來時用估計值，畫面才能馬上顯示「已送出」。
      const stored = snapshot.data({ serverTimestamps: 'estimate' });
      const status: RevisionCheckStatus = stored.status === 'running' || stored.status === 'done' ? stored.status : '';
      onData({
        requestedAt: toIso(stored.requestedAt),
        requestedByName: stored.requestedByName ?? '',
        handledRequestAt: toIso(stored.handledRequestAt),
        status,
        startedAt: toIso(stored.startedAt),
        finishedAt: toIso(stored.finishedAt),
        checkedCount: toCount(stored.checkedCount),
        comparedCount: toCount(stored.comparedCount),
      });
    },
    (error) =>
      onError(new Error(`讀取立即比對狀態失敗（revisionCheckService.subscribeRevisionCheck）：${error.message}`)),
  );
}

/**
 * 送出「立即比對」請求（只動請求欄位，監看寫回的狀態保留）。
 *
 * @throws 寫入失敗時（含權限不足）
 */
export async function requestRevisionCheck(user: AppUser): Promise<void> {
  try {
    await setDoc(
      doc(db, COLLECTIONS.unlockControl, REVISION_CHECK_DOC_ID),
      {
        requestedAt: serverTimestamp(),
        requestedBy: user.uid,
        requestedByName: user.displayName || user.email,
      },
      { merge: true },
    );
  } catch (error) {
    throw new Error(`送出立即比對失敗（revisionCheckService.requestRevisionCheck）：${(error as Error).message}`);
  }
}
