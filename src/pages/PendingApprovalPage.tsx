/**
 * 帳號待審核 / 未通過的提示頁。
 * 已登入但帳號尚未被管理員核准時顯示，取代所有受保護頁面（不載入任何業務資料）。
 * 管理員核准後，AuthProvider 的即時訂閱會自動更新狀態，畫面直接進入系統，不需重新登入。
 */
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { logout } from '../services/authService';
import { ADMIN_EMAILS, APP_NAME } from '../config/constants';
import { Button, Card } from '../components/ui';

export function PendingApprovalPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const rejected = user?.status === 'rejected';

  async function handleLogout() {
    try {
      await logout();
    } catch (error) {
      console.error(error);
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-xl font-bold text-slate-800">{APP_NAME}</h1>
        {rejected ? (
          <>
            <p className="text-base font-bold text-red-600">此帳號未通過審核</p>
            <p className="text-sm text-slate-600">
              管理員尚未開放此帳號使用本系統。若有疑問，請聯絡管理員（{ADMIN_EMAILS[0]}）。
            </p>
          </>
        ) : (
          <>
            <p className="text-base font-bold text-amber-600">帳號等待管理員核准</p>
            <p className="text-sm text-slate-600">
              你的註冊申請已送出，需由管理員（{ADMIN_EMAILS[0]}）核准後才能使用系統。
              核准後這個畫面會自動進入系統，不必重新登入。
            </p>
          </>
        )}
        <div className="rounded-lg bg-slate-50 p-3 text-left text-sm text-slate-600">
          <p>帳號：{user?.email}</p>
          <p>名稱：{user?.displayName}</p>
        </div>
        <Button variant="secondary" onClick={handleLogout} className="w-full">
          登出
        </Button>
      </Card>
    </div>
  );
}
