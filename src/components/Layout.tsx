/**
 * 登入後的主版面：頂部導覽列 + 內容區。
 * 響應式設計，桌機/平板/手機皆可用。
 */
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { logout } from '../services/authService';
import { APP_NAME } from '../config/constants';
import { Button } from './ui';

export function Layout() {
  const { user } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (error) {
      // 登出失敗極少見；仍導回登入頁並在主控台留存訊息。
      console.error(error);
      navigate('/login', { replace: true });
    }
  }

  const navItemClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
      isActive ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'
    }`;

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <span className="text-lg font-bold text-slate-800">{APP_NAME}</span>
          <nav className="flex flex-1 items-center gap-1">
            <NavLink to="/" end className={navItemClass}>
              首頁
            </NavLink>
            <NavLink to="/categories" className={navItemClass}>
              屬性管理
            </NavLink>
            <NavLink to="/tools" className={navItemClass}>
              小工具
            </NavLink>
          </nav>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="hidden sm:inline">{user?.displayName}</span>
            <Button variant="ghost" onClick={handleLogout}>
              登出
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
