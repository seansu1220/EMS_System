/** 登入頁。 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { login } from '../services/authService';
import { useAuth } from '../hooks/useAuth';
import { APP_NAME } from '../config/constants';
import { Button, Card, ErrorBanner, FieldLabel, INPUT_CLASS } from '../components/ui';
import { GoogleSignInButton } from '../components/GoogleSignInButton';

export function LoginPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 已登入者直接導向原本要去的頁面或首頁。
  if (!loading && user) {
    const from = (location.state as { from?: Location })?.from?.pathname ?? '/';
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login({ email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-xl font-bold text-slate-800">{APP_NAME}</h1>
        <p className="mb-5 text-center text-sm text-slate-500">請登入以繼續</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <FieldLabel>Email</FieldLabel>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={INPUT_CLASS}
              autoComplete="email"
            />
          </div>
          <div>
            <FieldLabel>密碼</FieldLabel>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={INPUT_CLASS}
              autoComplete="current-password"
            />
          </div>
          <ErrorBanner message={error} />
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? '登入中…' : '登入'}
          </Button>
        </form>

        <div className="my-4 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          或
          <span className="h-px flex-1 bg-slate-200" />
        </div>
        <GoogleSignInButton onError={setError} />

        <p className="mt-4 text-center text-sm text-slate-500">
          還沒有帳號？{' '}
          <Link to="/register" className="font-medium text-slate-800 underline">
            註冊
          </Link>
        </p>
      </Card>
    </div>
  );
}
