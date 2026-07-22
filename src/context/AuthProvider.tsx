/**
 * 驗證狀態 Provider。
 * 監聽 Firebase 登入狀態，載入對應的使用者資料文件，並於首次登入建立預設屬性。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { fetchUserProfile } from '../services/authService';
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
          const profile = await fetchUserProfile(firebaseUser.uid);
          setUser(profile);
          // 首次登入自動建立預設屬性（採購、系統、其他）；已有屬性則不動作。
          if (profile) await ensureDefaultCategories(profile.uid);
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
