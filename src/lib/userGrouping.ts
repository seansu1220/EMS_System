/**
 * 使用者管理頁的分類邏輯（純函式，不依賴 React）。
 * 依帳號狀態切分頁，「目前使用者」再依角色分組。
 */
import { isAdminEmail } from './permissions';
import type { AppUser, UserRole, UserStatus } from '../types/user';

/** 依角色分好的一組使用者。 */
export interface UserRoleGroup {
  role: UserRole;
  users: AppUser[];
}

/**
 * 實際顯示用的角色：白名單 email 一律算管理員。
 * 管理員身分以 email 白名單為準，文件上的 role 可能還是 member。
 */
export function effectiveRole(user: AppUser): UserRole {
  return isAdminEmail(user.email) ? 'admin' : user.role;
}

/** 各狀態的帳號數（給分頁標籤顯示數字）。 */
export function countUsersByStatus(users: readonly AppUser[]): Record<UserStatus, number> {
  const counts: Record<UserStatus, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const user of users) counts[user.status] = (counts[user.status] ?? 0) + 1;
  return counts;
}

/** 只留某個狀態的帳號，保持原本排序。 */
export function filterUsersByStatus(users: readonly AppUser[], status: UserStatus): AppUser[] {
  return users.filter((user) => user.status === status);
}

/**
 * 依角色分組，組別順序依 `roleOrder`；不在清單內的角色排最後。
 * 沒有人的角色不會出現。
 */
export function groupUsersByRole(users: readonly AppUser[], roleOrder: readonly string[]): UserRoleGroup[] {
  const byRole = new Map<UserRole, AppUser[]>();
  for (const user of users) {
    const role = effectiveRole(user);
    const list = byRole.get(role) ?? [];
    list.push(user);
    byRole.set(role, list);
  }
  const rank = (role: string) => {
    const index = roleOrder.indexOf(role);
    return index === -1 ? roleOrder.length : index;
  };
  return [...byRole.entries()]
    .sort(([roleA], [roleB]) => rank(roleA) - rank(roleB))
    .map(([role, list]) => ({ role, users: list }));
}
