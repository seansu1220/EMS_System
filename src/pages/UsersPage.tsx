/**
 * 使用者管理頁（僅管理員可進入）。
 * 列出所有註冊帳號（待審核排最前），可核准、拒絕、停用、指派角色；
 * 管理員本身的帳號不可調整（管理員身分來自 email 白名單）。
 */
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { setUserRole, setUserStatus, subscribeUsers } from '../services/userService';
import { isAdminEmail } from '../lib/permissions';
import { ASSIGNABLE_ROLES, USER_ROLE_LABELS, USER_STATUS_LABELS } from '../config/constants';
import type { AppUser, UserRole, UserStatus } from '../types/user';
import { Badge, Button, CenteredSpinner, ErrorBanner, INPUT_CLASS } from '../components/ui';

export function UsersPage() {
  const { user, isAdmin } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    const unsubscribe = subscribeUsers(
      (list) => {
        setUsers(list);
        setError(null);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [isAdmin]);

  // 非管理員直接導回首頁（安全規則同樣會擋下讀取）。
  if (!isAdmin) return <Navigate to="/" replace />;

  /** 變更帳號狀態（含二次確認）。 */
  async function handleSetStatus(target: AppUser, status: UserStatus, confirmText: string) {
    if (!user) return;
    if (!window.confirm(confirmText)) return;
    setBusyUid(target.uid);
    setError(null);
    try {
      await setUserStatus(target.uid, status, user.uid);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyUid(null);
    }
  }

  /** 變更帳號角色（解鎖專用 ⇄ 一般使用者）。 */
  async function handleSetRole(target: AppUser, role: Exclude<UserRole, 'admin'>) {
    if (!user) return;
    setBusyUid(target.uid);
    setError(null);
    try {
      await setUserRole(target.uid, role, user.uid);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyUid(null);
    }
  }

  const pendingCount = users.filter((item) => item.status === 'pending').length;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">使用者管理</h1>
        <p className="mt-1 text-sm text-slate-500">
          新註冊的帳號預設為「待審核」，須在此核准後才能登入使用系統。
          一般使用者可新增與編輯業務，但不能刪除業務；
          <strong>解鎖專用</strong>帳號只進得去解鎖工單頁，看不到任何業務資料（給各分隊申請解鎖用）。
        </p>
      </div>

      <ErrorBanner message={error} />

      {pendingCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          有 {pendingCount} 個帳號等待審核。
        </div>
      )}

      {loading ? (
        <CenteredSpinner />
      ) : users.length === 0 ? (
        <p className="text-sm text-slate-400">尚無使用者資料。</p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
          {users.map((item) => (
            <UserRow
              key={item.uid}
              item={item}
              busy={busyUid === item.uid}
              isSelf={item.uid === user?.uid}
              onApprove={() =>
                handleSetStatus(item, 'approved', `確定核准「${item.displayName || item.email}」使用系統？`)
              }
              onReject={() =>
                handleSetStatus(
                  item,
                  'rejected',
                  `確定停用「${item.displayName || item.email}」？停用後他將無法進入系統（資料不會刪除）。`,
                )
              }
              onChangeRole={(role) => handleSetRole(item, role)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 單列使用者：顯示名稱 / email / 角色 / 狀態，並依狀態提供核准或停用按鈕。 */
function UserRow({
  item,
  busy,
  isSelf,
  onApprove,
  onReject,
  onChangeRole,
}: {
  item: AppUser;
  busy: boolean;
  isSelf: boolean;
  onApprove: () => void;
  onReject: () => void;
  onChangeRole: (role: Exclude<UserRole, 'admin'>) => void;
}) {
  const statusLabel = USER_STATUS_LABELS[item.status] ?? USER_STATUS_LABELS.pending;
  // 管理員（白名單 email）的權限來自 email，不可在此調整。
  const locked = isSelf || isAdminEmail(item.email);

  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">
          {item.displayName || '（未命名）'}
          {isSelf && <span className="ml-2 text-xs text-slate-400">（你自己）</span>}
        </p>
        <p className="truncate text-xs text-slate-500">{item.email}</p>
      </div>
      {locked ? (
        <span className="text-xs text-slate-500">{USER_ROLE_LABELS[item.role] ?? item.role}</span>
      ) : (
        <select
          className={`${INPUT_CLASS} w-auto py-1 text-xs`}
          value={item.role}
          disabled={busy}
          onChange={(event) => onChangeRole(event.target.value as Exclude<UserRole, 'admin'>)}
          title={ASSIGNABLE_ROLES.find((role) => role.value === item.role)?.hint}
        >
          {ASSIGNABLE_ROLES.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label}
            </option>
          ))}
        </select>
      )}
      <Badge tone={statusLabel.tone}>{statusLabel.label}</Badge>
      {locked ? (
        <span className="text-xs text-slate-400">管理員帳號</span>
      ) : (
        <div className="flex gap-2">
          {item.status !== 'approved' && (
            <Button className="px-3 py-1.5 text-xs" onClick={onApprove} disabled={busy}>
              {busy ? '處理中…' : '核准'}
            </Button>
          )}
          {item.status !== 'rejected' && (
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-xs"
              onClick={onReject}
              disabled={busy}
            >
              {item.status === 'approved' ? '停用' : '拒絕'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
