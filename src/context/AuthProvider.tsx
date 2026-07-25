/**
 * 驗證狀態 Provider。
 * 監聽 Firebase 登入狀態，**即時訂閱**使用者資料文件（管理員核准後畫面自動解鎖，不需重新登入），
 * 並於已核准時確保預設屬性存在。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ensureUserDoc, fetchUserProfile, subscribeUserProfile } from '../services/authService';
import { ensureDefaultCategories } from '../services/categoryService';
import { isAdmin, isApproved, resolveInitialStatus, resolveRole } from '../lib/permissions';
import type { AppUser } from '../types/user';
import { AuthContext, type AuthContextValue } from './authContext';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  // 預設屬性只嘗試建立一次，避免使用者文件每次更新都重跑。
  const defaultsEnsuredRef = useRef(false);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      unsubscribeProfile?.();
      unsubscribeProfile = null;
      defaultsEnsuredRef.current = false;

      if (!firebaseUser) {
        setUser(null);
        setLoading(false);
        return;
      }

      const { uid } = firebaseUser;
      const email = firebaseUser.email ?? '';
      const fallbackName = firebaseUser.displayName ?? email ?? '使用者';
      // 首次登入時 users 文件是登入後才建立，先確保存在再訂閱，
      // 否則會讀到 null 而被誤判為未登入（競態）。
      try {
        await ensureUserDoc(uid, email, fallbackName);
      } catch (error) {
        console.error('建立使用者資料失敗：', error);
      }

      // 讀不到文件時以 Firebase 登入資訊組備援資料，狀態依 email 白名單推導。
      const fallbackProfile: AppUser = {
        uid,
        email,
        displayName: fallbackName,
        role: resolveRole(email),
        status: resolveInitialStatus(email),
        createdAt: '',
        reviewedAt: null,
        reviewedBy: null,
      };

      unsubscribeProfile = subscribeUserProfile(
        uid,
        (profile) => {
          // email 一律以 Firebase 登入資訊為準（安全規則也是用登入 token 的 email 判斷管理員），
          // 避免文件內 email 欄位缺漏時把管理員誤判成一般使用者。
          const nextUser = profile ? { ...profile, email: email || profile.email } : fallbackProfile;
          setUser(nextUser);
          setLoading(false);
          // 已核准者才碰 categories：待審核帳號會被安全規則擋下。
          if (!defaultsEnsuredRef.current && isApproved(nextUser)) {
            defaultsEnsuredRef.current = true;
            // 失敗只記錄，不影響登入狀態（屬性頁仍可手動建立）。
            ensureDefaultCategories(uid).catch((error) =>
              console.error('建立預設屬性失敗：', error),
            );
          }
        },
        (error) => {
          console.error('讀取使用者資料失敗：', error);
          setUser(fallbackProfile);
          setLoading(false);
        },
      );
    });

    return () => {
      unsubscribeProfile?.();
      unsubscribeAuth();
    };
  }, []);

  // 手動重新抓取目前登入者的資料文件（一般情況由即時訂閱自動更新）。
  const refreshUser = useCallback(async () => {
    if (!auth.currentUser) return;
    const profile = await fetchUserProfile(auth.currentUser.uid);
    setUser(profile);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      refreshUser,
      isAdmin: isAdmin(user),
      isApproved: isApproved(user),
    }),
    [user, loading, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
