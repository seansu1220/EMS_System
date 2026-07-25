/**
 * 路由權限守衛。
 * - 未登入：導向登入頁。
 * - 已登入但帳號未經管理員核准：顯示待審核提示頁（不進入系統、不載入任何業務資料）。
 * - 判斷登入狀態時顯示載入畫面。
 */
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';
import { PendingApprovalPage } from '../pages/PendingApprovalPage';
import { CenteredSpinner } from './ui';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading, isApproved } = useAuth();
  const location = useLocation();

  if (loading) return <CenteredSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!isApproved) return <PendingApprovalPage />;

  return <>{children}</>;
}
