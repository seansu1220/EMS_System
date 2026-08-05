/**
 * 解鎖工單的業務邏輯：送出、訂閱、回寫結果。不依賴 React。
 *
 * 這條流程橫跨兩端：**網頁送出工單 → 本機工具實際解鎖 → 結果回寫網頁**。
 * 本檔是網頁那一端；本機那一端在 `tools/ems-report/unlockQueue.mjs`，
 * 兩邊共用 `types/unlockRequest.ts` 定義的欄位，改欄位要一起改。
 *
 * 權限由 Firestore Security Rules 強制：
 * - 已核准的帳號都可以送出工單（含「解鎖專用」角色）
 * - 解鎖專用帳號**只讀得到自己送的**；管理員與一般使用者讀得到全部
 * - 只有管理員與一般使用者可以回寫結果（實際去跑解鎖的人）
 */
import {
  addDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS, UNLOCK_REQUEST_MAX_BATCH } from '../config/constants';
import type { AppUser } from '../types/user';
import type { UnlockRequest, UnlockRequestResult } from '../types/unlockRequest';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 將 Firestore 文件轉為強型別工單。 */
function mapRequest(snapshot: QueryDocumentSnapshot<DocumentData>): UnlockRequest {
  const data = snapshot.data();
  const result = data.result as Partial<UnlockRequestResult> | null | undefined;
  return {
    id: snapshot.id,
    temsis: data.temsis ?? '',
    reason: data.reason ?? '',
    requestedBy: data.requestedBy ?? '',
    requestedByName: data.requestedByName ?? '',
    requestedAt: toIso(data.requestedAt),
    status: data.status ?? 'pending',
    result: result
      ? {
          caseDate: result.caseDate ?? null,
          vehicle: result.vehicle ?? null,
          squad: result.squad ?? null,
          detail: result.detail ?? '',
          processedAt: toIso(result.processedAt),
          processedBy: result.processedBy ?? '',
        }
      : null,
  };
}

/**
 * 把使用者貼上的一大段文字拆成 TEMSIS 清單。
 *
 * 一行一個最常見，但也接受一行貼多個（空白、逗號、分號分隔）——
 * 從 Excel 複製一整欄貼過來時什麼分隔都可能出現。**重複的只留一筆**。
 *
 * @returns 去除空白與重複後的編號清單
 */
export function parseTemsisList(raw: string): string[] {
  const parts = String(raw ?? '')
    .split(/[\s,，;；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

/**
 * 送出一批解鎖工單（一個 TEMSIS 一張工單，方便逐筆回報結果）。
 *
 * @param user 申請人（顯示名稱會一併存下，看清單時不必再查 users）
 * @returns 實際建立的工單數
 * @throws 清單為空、超過單次上限、或寫入失敗時
 */
export async function createUnlockRequests(
  user: AppUser,
  temsisList: string[],
  reason: string,
): Promise<number> {
  if (temsisList.length === 0) throw new Error('請至少填入一個 TEMSIS 編號。');
  if (temsisList.length > UNLOCK_REQUEST_MAX_BATCH) {
    throw new Error(
      `一次最多送 ${UNLOCK_REQUEST_MAX_BATCH} 筆，這次有 ${temsisList.length} 筆。`
        + '請確認是不是整欄誤貼進來了。',
    );
  }
  try {
    for (const temsis of temsisList) {
      await addDoc(collection(db, COLLECTIONS.unlockRequests), {
        temsis,
        reason: reason.trim(),
        requestedBy: user.uid,
        requestedByName: user.displayName || user.email,
        requestedAt: serverTimestamp(),
        status: 'pending',
        result: null,
      });
    }
    return temsisList.length;
  } catch (error) {
    throw new Error(
      `送出解鎖工單失敗（unlockRequestService.createUnlockRequests）：${(error as Error).message}`,
    );
  }
}

/**
 * 訂閱解鎖工單（即時更新）。
 *
 * `onlyMine` 為 true 時只訂閱自己送出的——這**不只是畫面篩選**，
 * 解鎖專用帳號的安全規則就是只准讀自己的，查詢條件沒帶上去會被規則直接拒絕。
 * 排序在用戶端做，不需要複合索引。
 *
 * @returns 取消訂閱函式
 */
export function subscribeUnlockRequests(
  options: { uid: string; onlyMine: boolean },
  onData: (requests: UnlockRequest[]) => void,
  onError: (error: Error) => void,
): () => void {
  const base = collection(db, COLLECTIONS.unlockRequests);
  const target = options.onlyMine
    ? query(base, where('requestedBy', '==', options.uid))
    : query(base);
  return onSnapshot(
    target,
    (snapshot) => {
      const requests = snapshot.docs.map(mapRequest);
      // 新的排前面；時間讀不到的（剛送出、serverTimestamp 還沒回來）也排前面。
      requests.sort((left, right) => (right.requestedAt || '9999').localeCompare(left.requestedAt || '9999'));
      onData(requests);
    },
    (error) =>
      onError(
        new Error(`讀取解鎖工單失敗（unlockRequestService.subscribeUnlockRequests）：${error.message}`),
      ),
  );
}
