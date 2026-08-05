/**
 * 路由權限守衛。
 * - 未登入：導向登入頁。
 * - 已登入但帳號未經管理員核准：顯示待審核提示頁（不進入系統、不載入任何業務資料）。
 * - **「解鎖專用」帳號**：只准進解鎖工單頁，其餘一律導向 `/unlock`。
 * - 判斷登入狀態時顯示載入畫面。
 */
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';
import { PendingApprovalPage } from '../pages/PendingApprovalPage';
import { CenteredSpinner } from './ui';

/** 解鎖工單頁的路徑（解鎖專用帳號唯一去得了的地方）。 */
export const UNLOCK_PATH = '/unlock';

export function ProtectedRoute({
  children,
  /** 這條路由屬於業務管理系統（解鎖專用帳號進不來）。解鎖工單頁請設為 false。 */
  requireTaskSystem = true,
}: {
  children: ReactNode;
  requireTaskSystem?: boolean;
}) {
  const { user, loading, isApproved, canUseTasks } = useAuth();
  const location = useLocation();

  if (loading) return <CenteredSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!isApproved) return <PendingApprovalPage />;
  // 前端擋下只是為了不讓人看到一頁載不出資料的畫面；真正的防線是 Firestore 規則。
  if (requireTaskSystem && !canUseTasks) return <Navigate to={UNLOCK_PATH} replace />;

  return <>{children}</>;
}
