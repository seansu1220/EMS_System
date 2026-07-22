/** 註冊頁。 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { register } from '../services/authService';
import { useAuth } from '../hooks/useAuth';
import { APP_NAME } from '../config/constants';
import { Button, Card, ErrorBanner, FieldLabel, INPUT_CLASS } from '../components/ui';
import { GoogleSignInButton } from '../components/GoogleSignInButton';

export function RegisterPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!displayName.trim()) {
      setError('請填寫顯示名稱。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await register({ email, password, displayName: displayName.trim() });
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
        <p className="mb-5 text-center text-sm text-slate-500">建立新帳號</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <FieldLabel>顯示名稱</FieldLabel>
            <input
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={INPUT_CLASS}
              autoComplete="name"
            />
          </div>
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
              autoComplete="new-password"
              placeholder="至少 6 碼"
            />
          </div>
          <ErrorBanner message={error} />
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? '註冊中…' : '註冊'}
          </Button>
        </form>

        <div className="my-4 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          或
          <span className="h-px flex-1 bg-slate-200" />
        </div>
        <GoogleSignInButton onError={setError} />

        <p className="mt-4 text-center text-sm text-slate-500">
          已經有帳號？{' '}
          <Link to="/login" className="font-medium text-slate-800 underline">
            登入
          </Link>
        </p>
      </Card>
    </div>
  );
}
