/**
 * 驗證狀態 Provider。
 * 監聽 Firebase 登入狀態，載入對應的使用者資料文件，並於首次登入建立預設屬性。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ensureUserDoc, fetchUserProfile } from '../services/authService';
import { ensureDefaultCategories } from '../services/categoryService';
import type { AppUser } from '../types/user';
import { AuthContext, type AuthContextValue } from './authContext';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      try {
        if (firebaseUser) {
          const { uid } = firebaseUser;
          const email = firebaseUser.email ?? '';
          const fallbackName = firebaseUser.displayName ?? email ?? '使用者';
          // 先確保 users 文件存在再讀取：首次登入時文件是登入後才建立，
          // 直接讀會拿到 null 而被誤判為未登入（競態）。
          await ensureUserDoc(uid, email, fallbackName);
          const profile = await fetchUserProfile(uid);
          setUser(profile ?? { uid, email, displayName: fallbackName, createdAt: '' });
          // 首次登入自動建立預設屬性（採購、系統、其他）；已有屬性則不動作。
          // 失敗只記錄，不影響登入狀態（屬性頁仍可手動建立）。
          try {
            await ensureDefaultCategories(uid);
          } catch (categoryError) {
            console.error('建立預設屬性失敗：', categoryError);
          }
        } else {
          setUser(null);
        }
      } catch (error) {
        console.error('載入使用者資料失敗：', error);
        setUser(null);
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  // 重新抓取目前登入者的資料文件（改名後刷新顯示）。
  const refreshUser = useCallback(async () => {
    if (!auth.currentUser) return;
    const profile = await fetchUserProfile(auth.currentUser.uid);
    setUser(profile);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, refreshUser }),
    [user, loading, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
