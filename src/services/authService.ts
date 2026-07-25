/**
 * 驗證（Authentication）相關業務邏輯。
 * 不依賴任何 UI 框架，方便獨立測試或替換前端。
 */
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, type DocumentData } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import { resolveInitialStatus, resolveRole } from '../lib/permissions';
import type { AppUser, LoginInput, RegisterInput, UserRole, UserStatus } from '../types/user';

/** 將 Firebase 錯誤碼轉成中文訊息。 */
function toFriendlyMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  const map: Record<string, string> = {
    'auth/email-already-in-use': '此 email 已被註冊。',
    'auth/invalid-email': 'email 格式不正確。',
    'auth/weak-password': '密碼強度不足（至少 6 碼）。',
    'auth/user-not-found': '查無此帳號。',
    'auth/wrong-password': '密碼錯誤。',
    'auth/invalid-credential': 'email 或密碼錯誤。',
    'auth/too-many-requests': '嘗試次數過多，請稍後再試。',
    'auth/popup-closed-by-user': '已取消 Google 登入。',
    'auth/cancelled-popup-request': '已取消 Google 登入。',
    'auth/popup-blocked': '瀏覽器封鎖了登入彈出視窗，請允許彈出視窗後再試。',
  };
  return map[code] ?? `操作失敗（${code || (error as Error)?.message || '未知錯誤'}）`;
}

/**
 * 由 Firestore 原始資料組出強型別 AppUser。
 * 舊資料（v1.7 前）沒有 role/status 欄位，依 email 白名單推導：
 * 管理員 → admin/approved；其他人 → member/pending（保守，須經核准）。
 */
function mapUserData(uid: string, data: DocumentData): AppUser {
  const email = data.email ?? '';
  return {
    uid,
    email,
    displayName: data.displayName ?? '',
    role: (data.role as UserRole) ?? resolveRole(email),
    status: (data.status as UserStatus) ?? resolveInitialStatus(email),
    createdAt: toIso(data.createdAt),
    reviewedAt: data.reviewedAt ? toIso(data.reviewedAt) : null,
    reviewedBy: data.reviewedBy ?? null,
  };
}

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/**
 * 確保 users 文件存在且含角色/狀態欄位。由 AuthProvider 於登入狀態變化時呼叫，
 * 避免「登入成功但文件尚未建立」的競態導致被誤判為未登入。
 * - 文件不存在：建立，role/status 依 email 白名單決定（一般帳號為 pending，須管理員核准）。
 * - 文件已存在且已有 status：不覆寫（避免每次登入把管理員改過的狀態洗掉）。
 * - 文件已存在但缺 status（v1.7 前的舊資料）：補寫推導值；
 *   安全規則只允許管理員改自己的 role/status，一般帳號補寫失敗時由呼叫端忽略。
 */
export async function ensureUserDoc(uid: string, email: string, displayName: string): Promise<void> {
  const ref = doc(db, COLLECTIONS.users, uid);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) {
    await setDoc(ref, {
      uid,
      email,
      displayName,
      role: resolveRole(email),
      status: resolveInitialStatus(email),
      reviewedAt: null,
      reviewedBy: null,
      createdAt: serverTimestamp(),
    });
    return;
  }
  if (typeof snapshot.data().status === 'string') return;
  await setDoc(ref, { role: resolveRole(email), status: resolveInitialStatus(email) }, { merge: true });
}

/** 以 Google 帳號登入；首次登入自動建立 users 文件。 */
export async function loginWithGoogle(): Promise<void> {
  try {
    const provider = new GoogleAuthProvider();
    // 每次都跳出「選擇帳號」畫面，避免自動沿用上次登入的同一帳號、無法切換。
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    const { uid, email, displayName } = result.user;
    await ensureUserDoc(uid, email ?? '', displayName ?? email ?? '使用者');
  } catch (error) {
    throw new Error(toFriendlyMessage(error));
  }
}

/** 註冊新帳號，同時在 users 集合建立對應文件。 */
export async function register({ email, password, displayName }: RegisterInput): Promise<void> {
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const { uid } = credential.user;
    await updateProfile(credential.user, { displayName });
    await setDoc(doc(db, COLLECTIONS.users, uid), {
      uid,
      email,
      displayName,
      // 一般帳號註冊後為「待審核」，須由管理員核准才能進入系統。
      role: resolveRole(email),
      status: resolveInitialStatus(email),
      reviewedAt: null,
      reviewedBy: null,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(toFriendlyMessage(error));
  }
}

/** 以 email/密碼登入。 */
export async function login({ email, password }: LoginInput): Promise<void> {
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    throw new Error(toFriendlyMessage(error));
  }
}

/** 登出。 */
export async function logout(): Promise<void> {
  try {
    await signOut(auth);
  } catch (error) {
    throw new Error(`登出失敗：${(error as Error).message}`);
  }
}

/**
 * 讀取指定 uid 的使用者資料文件。
 * 若文件不存在（例如舊帳號尚未建立），回傳 null。
 */
export async function fetchUserProfile(uid: string): Promise<AppUser | null> {
  try {
    const snapshot = await getDoc(doc(db, COLLECTIONS.users, uid));
    if (!snapshot.exists()) return null;
    return mapUserData(uid, snapshot.data());
  } catch (error) {
    throw new Error(`讀取使用者資料失敗（authService.fetchUserProfile）：${(error as Error).message}`);
  }
}

/**
 * 訂閱指定 uid 的使用者資料文件（即時更新）。
 * 管理員核准帳號後，待審核者的畫面會即時解鎖，不需重新登入。
 * @returns 取消訂閱函式
 */
export function subscribeUserProfile(
  uid: string,
  onData: (user: AppUser | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COLLECTIONS.users, uid),
    (snapshot) => onData(snapshot.exists() ? mapUserData(uid, snapshot.data()) : null),
    (error) =>
      onError(
        new Error(`讀取使用者資料失敗（authService.subscribeUserProfile）：${error.message}`),
      ),
  );
}
