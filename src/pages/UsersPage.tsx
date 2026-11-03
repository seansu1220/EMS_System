/**
 * 使用者管理頁（僅管理員可進入）。
 * 上方分頁切「目前使用者／停用／待審核」（v1.36），「目前使用者」再依角色分組；
 * 可核准、拒絕、停用、重新啟用、指派角色；
 * 管理員本身的帳號不可調整（管理員身分來自 email 白名單）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { setUserRole, setUserStatus, subscribeUsers } from '../services/userService';
import { isAdminEmail } from '../lib/permissions';
import { countUsersByStatus, filterUsersByStatus, groupUsersByRole } from '../lib/userGrouping';
import { ASSIGNABLE_ROLES, USER_ROLE_GROUP_ORDER, USER_ROLE_LABELS, USER_TABS } from '../config/constants';
import type { AppUser, UserRole, UserStatus } from '../types/user';
import { Button, CenteredSpinner, ErrorBanner, INPUT_CLASS } from '../components/ui';

export function UsersPage() {
  const { user, isAdmin } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  // null＝還沒手動切過分頁，由待審核數量決定預設分頁。
  const [selectedTab, setSelectedTab] = useState<UserStatus | null>(null);
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

  /** 變更帳號角色（一般使用者／救護科管理者／解鎖專用）。 */
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

  const statusCounts = countUsersByStatus(users);
  // 還沒手動切過分頁時：有人待審核就先開「待審核」，否則開「目前使用者」。
  const activeTab: UserStatus = selectedTab ?? (statusCounts.pending > 0 ? 'pending' : 'approved');
  const tabUsers = filterUsersByStatus(users, activeTab);
  const tabEmptyText = USER_TABS.find((tab) => tab.status === activeTab)?.emptyText ?? '';

  function renderRow(item: AppUser) {
    const name = item.displayName || item.email;
    return (
      <UserRow
        key={item.uid}
        item={item}
        busy={busyUid === item.uid}
        isSelf={item.uid === user?.uid}
        onApprove={() =>
          handleSetStatus(
            item,
            'approved',
            item.status === 'rejected' ? `確定重新啟用「${name}」？` : `確定核准「${name}」使用系統？`,
          )
        }
        onReject={() =>
          handleSetStatus(item, 'rejected', `確定停用「${name}」？停用後他將無法進入系統（資料不會刪除）。`)
        }
        onChangeRole={(role) => handleSetRole(item, role)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">使用者管理</h1>
        <p className="mt-1 text-sm text-slate-500">
          新註冊的帳號預設為「待審核」，須在此核准後才能登入使用系統。
          一般使用者可新增與編輯業務，但不能刪除業務；
          <strong>救護科管理者</strong>只能用解鎖工單、測試用傷票領取與小工具（看不到業務資料），但看得到所有人的工單、可以鎖定／解鎖申請解鎖的時段；
          <strong>解鎖專用</strong>帳號只進得去解鎖工單頁，看不到任何業務資料（給各分隊申請解鎖用）。
        </p>
      </div>

      <ErrorBanner message={error} />

      {statusCounts.pending > 0 && activeTab !== 'pending' && (
        <button
          type="button"
          onClick={() => setSelectedTab('pending')}
          className="block w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-left text-sm text-amber-800 hover:bg-amber-100"
        >
          有 {statusCounts.pending} 個帳號等待審核，點這裡查看。
        </button>
      )}

      <div className="flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5" role="tablist" aria-label="使用者分類">
        {USER_TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.status}
            onClick={() => setSelectedTab(tab.status)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === tab.status ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {tab.label}
            <span className={`ml-1.5 text-xs ${tab.status === 'pending' && statusCounts.pending > 0 ? 'font-bold text-amber-500' : 'opacity-70'}`}>
              {statusCounts[tab.status]}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <CenteredSpinner />
      ) : tabUsers.length === 0 ? (
        <p className="text-sm text-slate-400">{tabEmptyText}</p>
      ) : activeTab === 'approved' ? (
        <div className="space-y-4">
          {groupUsersByRole(tabUsers, USER_ROLE_GROUP_ORDER).map((group) => (
            <section key={group.role}>
              <h2 className="mb-2 text-sm font-semibold text-slate-600">
                {USER_ROLE_LABELS[group.role] ?? group.role}
                <span className="ml-1.5 text-xs font-normal text-slate-400">{group.users.length} 人</span>
              </h2>
              <UserList>{group.users.map(renderRow)}</UserList>
            </section>
          ))}
        </div>
      ) : (
        <UserList>{tabUsers.map(renderRow)}</UserList>
      )}
    </div>
  );
}

/** 使用者列的外框。 */
function UserList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">{children}</div>;
}

/** 單列使用者：顯示名稱 / email / 角色，並依狀態提供核准、重新啟用或停用按鈕（狀態由所在分頁表示）。 */
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
      {locked ? (
        <span className="text-xs text-slate-400">管理員帳號</span>
      ) : (
        <div className="flex gap-2">
          {item.status !== 'approved' && (
            <Button className="px-3 py-1.5 text-xs" onClick={onApprove} disabled={busy}>
              {busy ? '處理中…' : item.status === 'rejected' ? '重新啟用' : '核准'}
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
