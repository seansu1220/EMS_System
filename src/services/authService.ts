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
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import type { AppUser, LoginInput, RegisterInput } from '../types/user';

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
 * 確保 users 文件存在；若不存在（例如首次以 Google 登入）則建立。
 * 已存在則不覆寫。
 */
async function ensureUserDoc(uid: string, email: string, displayName: string): Promise<void> {
  const ref = doc(db, COLLECTIONS.users, uid);
  const snapshot = await getDoc(ref);
  if (snapshot.exists()) return;
  await setDoc(ref, {
    uid,
    email,
    displayName,
    createdAt: serverTimestamp(),
  });
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
    const data = snapshot.data();
    return {
      uid,
      email: data.email ?? '',
      displayName: data.displayName ?? '',
      createdAt:
        typeof data.createdAt?.toDate === 'function'
          ? data.createdAt.toDate().toISOString()
          : (data.createdAt ?? ''),
    };
  } catch (error) {
    throw new Error(`讀取使用者資料失敗（authService.fetchUserProfile）：${(error as Error).message}`);
  }
}
