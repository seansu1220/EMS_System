/**
 * 權限判斷的純邏輯（角色、帳號狀態、可執行的動作）。
 * 不依賴 React 或 Firebase，皆為純函式，方便獨立測試。
 *
 * ⚠️ 這裡只負責「介面要不要顯示 / 要不要擋下」；真正的權限最終防線是
 * `firebase/firestore.rules`（即使前端被繞過，資料庫層仍會擋）。兩者須一致。
 */
import { ADMIN_EMAILS } from '../config/constants';
import type { AppUser, UserRole, UserStatus } from '../types/user';

/** email 是否在管理員白名單內（不分大小寫、去頭尾空白）。 */
export function isAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return ADMIN_EMAILS.some((adminEmail) => adminEmail.trim().toLowerCase() === normalized);
}

/** 依 email 決定角色（白名單內＝管理員）。 */
export function resolveRole(email: string): UserRole {
  return isAdminEmail(email) ? 'admin' : 'member';
}

/** 依 email 決定新帳號的初始狀態（管理員直接核准，其他人須等待審核）。 */
export function resolveInitialStatus(email: string): UserStatus {
  return isAdminEmail(email) ? 'approved' : 'pending';
}

/** 是否為管理員（以 email 白名單為準，避免文件被竄改後提權）。 */
export function isAdmin(user: AppUser | null): boolean {
  return user !== null && isAdminEmail(user.email);
}

/** 帳號是否已核准可使用系統（管理員一律視為已核准）。 */
export function isApproved(user: AppUser | null): boolean {
  if (user === null) return false;
  return isAdmin(user) || user.status === 'approved';
}

/** 是否可刪除業務（僅管理員）。 */
export function canDeleteTask(user: AppUser | null): boolean {
  return isAdmin(user);
}

/** 是否可管理使用者帳號（核准 / 停用；僅管理員）。 */
export function canManageUsers(user: AppUser | null): boolean {
  return isAdmin(user);
}
