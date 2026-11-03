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
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS, TEMSIS_CODE_LENGTH, UNLOCK_REQUEST_MAX_BATCH } from '../config/constants';
import { canManageUnlockLock } from '../lib/permissions';
import { formatRocMonth, isTemsisLocked } from '../lib/unlockLockLogic';
import type { AppUser } from '../types/user';
import type { MonthKey } from '../types/unlockPolicy';
import type {
  TemsisLengthError,
  TemsisLockedError,
  UnlockRequest,
  UnlockRequestResult,
  UnlockRequestRevision,
  UnlockRevisionState,
} from '../types/unlockRequest';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 認得的比對狀態；不認得的一律當「等待結案」，不會讓畫面壞掉。 */
const REVISION_STATES: readonly UnlockRevisionState[] = ['waiting', 'compared', 'superseded', 'expired', 'gaveUp'];

/** Firestore 的 `revision` 欄位 → 強型別；不是物件就當沒有。 */
function mapRevision(value: unknown): UnlockRequestRevision | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Record<keyof UnlockRequestRevision, unknown>>;
  const state = REVISION_STATES.includes(raw.state as UnlockRevisionState)
    ? (raw.state as UnlockRevisionState)
    : 'waiting';
  return {
    version: typeof raw.version === 'number' ? raw.version : 0,
    remark: typeof raw.remark === 'string' ? raw.remark : '',
    state,
    backedUpAt: toIso(raw.backedUpAt),
    lastCheckedAt: toIso(raw.lastCheckedAt) || null,
    comparedAt: toIso(raw.comparedAt) || null,
    changeCount: typeof raw.changeCount === 'number' ? raw.changeCount : null,
    items: Array.isArray(raw.items) ? raw.items.filter((item): item is string => typeof item === 'string') : [],
  };
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
    lockBypass: data.lockBypass === true,
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
    revision: mapRevision(data.revision),
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
 * 挑出長度不對的 TEMSIS 編號（純函式，不改動輸入）。
 *
 * 正確的編號固定 `TEMSIS_CODE_LENGTH` 碼；抄少一碼或多貼一碼送出去，
 * 本機工具那端只會回「查無案件」，申請人白等一輪才知道打錯。
 * 因此**送出前就先擋**，並把每一行的實際長度講清楚，讓人知道要補幾碼。
 *
 * @param temsisList 已用 `parseTemsisList` 拆好的清單
 * @returns 長度不符的項目（清單全部正確時為空陣列）
 */
export function findTemsisLengthErrors(temsisList: string[]): TemsisLengthError[] {
  return temsisList
    .filter((temsis) => temsis.length !== TEMSIS_CODE_LENGTH)
    .map((temsis) => ({ temsis, length: temsis.length }));
}

/** 長度不符時給使用者看的一句話（畫面與送出檢查共用同一種說法）。 */
export function describeTemsisLengthError({ temsis, length }: TemsisLengthError): string {
  return `${temsis}：TEMSIS碼長度為 ${TEMSIS_CODE_LENGTH} 碼，`
    + `目前輸入號碼長度為 ${length} 碼，請提供正確TEMSIS碼`;
}

/**
 * 挑出案件日期落在鎖定時段內的 TEMSIS 編號（純函式，v1.32 起）。
 *
 * 案件月份取 TEMSIS 前 6 碼；鎖定月份當月也算在內。
 * 安全規則用同一種比法再擋一次，這裡先擋是為了讓人當場看到原因，而不是一句「權限不足」。
 *
 * @param lockedThroughMonth 鎖定到哪個月（含）；null＝沒有鎖定
 */
export function findTemsisLockedErrors(
  temsisList: string[],
  lockedThroughMonth: MonthKey | null,
): TemsisLockedError[] {
  if (lockedThroughMonth === null) return [];
  return temsisList
    .filter((temsis) => isTemsisLocked(temsis, lockedThroughMonth))
    .map((temsis) => ({ temsis, lockedThroughMonth }));
}

/** 落在鎖定時段時給使用者看的一句話（畫面與送出檢查共用同一種說法）。 */
export function describeTemsisLockedError({ temsis, lockedThroughMonth }: TemsisLockedError): string {
  return `${temsis}：${formatRocMonth(lockedThroughMonth)}（含）以前的案件，該時段已經被鎖，請洽救護科人員`;
}

/**
 * 送出一批解鎖工單（一個 TEMSIS 一張工單，方便逐筆回報結果）。
 *
 * 管理員與救護科管理者**不受鎖定時段限制**（使用者 2026-11-03 指定）：
 * 他們送的工單一律帶 `lockBypass: true`，本機工具拿單時也不會把它標成「時段已鎖定」。
 *
 * @param user 申請人（顯示名稱會一併存下，看清單時不必再查 users）
 * @param lockedThroughMonth 目前的鎖定時段（含）；null＝沒有鎖定
 * @returns 實際建立的工單數
 * @throws 清單為空、超過單次上限、有編號長度不對、落在鎖定時段（非管理者）、或寫入失敗時
 */
export async function createUnlockRequests(
  user: AppUser,
  temsisList: string[],
  reason: string,
  lockedThroughMonth: MonthKey | null,
): Promise<number> {
  if (temsisList.length === 0) throw new Error('請至少填入一個 TEMSIS 編號。');
  if (temsisList.length > UNLOCK_REQUEST_MAX_BATCH) {
    throw new Error(
      `一次最多送 ${UNLOCK_REQUEST_MAX_BATCH} 筆，這次有 ${temsisList.length} 筆。`
        + '請確認是不是整欄誤貼進來了。',
    );
  }
  const lengthErrors = findTemsisLengthErrors(temsisList);
  if (lengthErrors.length > 0) {
    throw new Error(lengthErrors.map(describeTemsisLengthError).join('\n'));
  }
  const lockBypass = canManageUnlockLock(user);
  const lockedErrors = lockBypass ? [] : findTemsisLockedErrors(temsisList, lockedThroughMonth);
  if (lockedErrors.length > 0) {
    throw new Error(lockedErrors.map(describeTemsisLockedError).join('\n'));
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
        revision: null,
        lockBypass,
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
 * 把一張工單重新排隊，讓本機工具再跑一次。
 *
 * 用途：解鎖流程本身出過狀況（例如頁面沒載完就查詢，被誤判成「查無案件」），
 * 案件其實好好的。這種時候申請人不必重打一次編號，管理員按一下就重來。
 *
 * 狀態退回 `pending`、結果清空——**這兩件事必須一起做**，
 * 否則清單上會出現「待處理」卻掛著上次失敗說明的矛盾畫面。
 *
 * 重新送單只有管理員做得到，因此同時設 `lockBypass: true`（v1.33）：
 * 管理員親手重送＝要它真的跑，「時段已鎖定」的工單也照樣送去解鎖。
 *
 * @throws 寫入失敗時（含權限不足）
 */
export async function requeueUnlockRequest(requestId: string): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.unlockRequests, requestId), {
      status: 'pending',
      result: null,
      // 上一次的備份／比對進度跟著清掉：重跑會備份新的一版，舊的不該還掛在畫面上。
      revision: null,
      lockBypass: true,
    });
  } catch (error) {
    throw new Error(
      `重新送單失敗（unlockRequestService.requeueUnlockRequest）：${(error as Error).message}`,
    );
  }
}

/**
 * 刪除一張工單（僅管理員；安全規則同步限制）。
 *
 * 刪掉就沒了，呼叫端必須先向使用者確認。
 *
 * @throws 刪除失敗時（含權限不足）
 */
export async function deleteUnlockRequest(requestId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, COLLECTIONS.unlockRequests, requestId));
  } catch (error) {
    throw new Error(
      `刪除工單失敗（unlockRequestService.deleteUnlockRequest）：${(error as Error).message}`,
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
