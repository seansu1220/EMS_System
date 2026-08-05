/**
 * 使用者帳號管理業務邏輯（僅管理員可用）：列出所有帳號、核准 / 拒絕 / 停用。
 * 不依賴 React。權限由 Firestore Security Rules 強制
 * （users 的 list 與改 role/status 僅限管理員 email）。
 */
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import { resolveInitialStatus, resolveRole } from '../lib/permissions';
import type { AppUser, UserRole, UserStatus } from '../types/user';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 將 Firestore 文件轉為強型別 AppUser（舊資料缺 role/status 時依 email 推導）。 */
function mapUser(snapshot: QueryDocumentSnapshot<DocumentData>): AppUser {
  const data = snapshot.data();
  const email = data.email ?? '';
  return {
    uid: snapshot.id,
    email,
    displayName: data.displayName ?? '',
    role: (data.role as UserRole) ?? resolveRole(email),
    status: (data.status as UserStatus) ?? resolveInitialStatus(email),
    createdAt: toIso(data.createdAt),
    reviewedAt: data.reviewedAt ? toIso(data.reviewedAt) : null,
    reviewedBy: data.reviewedBy ?? null,
  };
}

/** 待審核優先，其次已核准、未通過；同組內依建立時間新到舊。 */
const STATUS_ORDER: Record<UserStatus, number> = { pending: 0, approved: 1, rejected: 2 };

function compareUsers(a: AppUser, b: AppUser): number {
  if (a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  return (b.createdAt || '').localeCompare(a.createdAt || '');
}

/**
 * 訂閱全部使用者帳號（即時更新，待審核排最前）。僅管理員可讀取。
 * @returns 取消訂閱函式
 */
export function subscribeUsers(
  onData: (users: AppUser[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COLLECTIONS.users),
    (snapshot) => onData(snapshot.docs.map(mapUser).sort(compareUsers)),
    (error) => onError(new Error(`讀取使用者清單失敗（userService.subscribeUsers）：${error.message}`)),
  );
}

/**
 * 變更帳號狀態（核准 / 拒絕 / 停用）；僅管理員可執行。
 * @param uid 目標帳號
 * @param status 新狀態
 * @param reviewerUid 審核者 uid（記錄於文件供追溯）
 */
export async function setUserStatus(
  uid: string,
  status: UserStatus,
  reviewerUid: string,
): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.users, uid), {
      status,
      reviewedAt: serverTimestamp(),
      reviewedBy: reviewerUid,
    });
  } catch (error) {
    throw new Error(`變更帳號狀態失敗（userService.setUserStatus）：${(error as Error).message}`);
  }
}

/**
 * 變更帳號角色（一般使用者 ⇄ 解鎖專用）；僅管理員可執行。
 *
 * ⚠ 不能用來指派 `admin`：管理員身分以 email 白名單認定
 * （見 `lib/permissions.ts` 與 `firestore.rules` 的 `isAdmin()`），
 * 改文件的 role 欄位並不會讓人變成管理員，開放這個選項只會誤導。
 *
 * @param uid 目標帳號
 * @param role 新角色
 * @param reviewerUid 操作者 uid（記錄於文件供追溯）
 */
export async function setUserRole(
  uid: string,
  role: Exclude<UserRole, 'admin'>,
  reviewerUid: string,
): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.users, uid), {
      role,
      reviewedAt: serverTimestamp(),
      reviewedBy: reviewerUid,
    });
  } catch (error) {
    throw new Error(`變更帳號角色失敗（userService.setUserRole）：${(error as Error).message}`);
  }
}
