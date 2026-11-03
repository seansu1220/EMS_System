/**
 * 解鎖工單「鎖定時段」的讀寫（v1.32 起）。不依賴 React。
 *
 * 全系統只有一份設定 `unlockPolicy/main`。權限由 Firestore Security Rules 強制：
 * - 已核准的帳號都讀得到（送出工單前要先知道哪些月份不能送）
 * - 只有管理員與「救護科管理者」改得動；不可刪除（刪掉會悄悄退回預設值）
 */
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS, UNLOCK_LOCK_DEFAULT_THROUGH_MONTH } from '../config/constants';
import type { AppUser } from '../types/user';
import type { MonthKey, UnlockPolicy } from '../types/unlockPolicy';

/** 設定文件的 ID（只有這一份）。 */
const POLICY_DOC_ID = 'main';

/** 資料庫還沒有設定文件時的預設值。 */
const DEFAULT_POLICY: UnlockPolicy = {
  lockedThroughMonth: UNLOCK_LOCK_DEFAULT_THROUGH_MONTH,
  updatedAt: '',
  updatedByName: '',
  isDefault: true,
};

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/**
 * 訂閱鎖定時段設定（即時更新：救護科管理者一改，所有人的送出檢查馬上跟著變）。
 *
 * @returns 取消訂閱函式
 */
export function subscribeUnlockPolicy(
  onData: (policy: UnlockPolicy) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COLLECTIONS.unlockPolicy, POLICY_DOC_ID),
    (snapshot) => {
      if (!snapshot.exists()) {
        onData(DEFAULT_POLICY);
        return;
      }
      const stored = snapshot.data();
      onData({
        lockedThroughMonth: typeof stored.lockedThroughMonth === 'string' ? stored.lockedThroughMonth : null,
        updatedAt: toIso(stored.updatedAt),
        updatedByName: stored.updatedByName ?? '',
        isDefault: false,
      });
    },
    (error) =>
      onError(
        new Error(`讀取鎖定時段失敗（unlockPolicyService.subscribeUnlockPolicy）：${error.message}`),
      ),
  );
}

/**
 * 改變鎖定範圍（鎖定、解鎖、全部解除都走這裡）。
 *
 * @param lockedThroughMonth 鎖定到哪個月（含）；null＝全部解除
 * @throws 寫入失敗時（含權限不足）
 */
export async function setLockedThroughMonth(
  user: AppUser,
  lockedThroughMonth: MonthKey | null,
): Promise<void> {
  try {
    await setDoc(doc(db, COLLECTIONS.unlockPolicy, POLICY_DOC_ID), {
      lockedThroughMonth,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
      updatedByName: user.displayName || user.email,
    });
  } catch (error) {
    throw new Error(
      `更新鎖定時段失敗（unlockPolicyService.setLockedThroughMonth）：${(error as Error).message}`,
    );
  }
}
