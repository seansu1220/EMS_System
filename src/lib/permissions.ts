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

/** 是否可刪除屬性（僅管理員；一般使用者仍可新增、改名、排序）。 */
export function canDeleteCategory(user: AppUser | null): boolean {
  return isAdmin(user);
}

/** 是否可刪除待辦公版（僅管理員；一般使用者仍可新增公版與編輯其項目）。 */
export function canDeleteTemplate(user: AppUser | null): boolean {
  return isAdmin(user);
}

/** 是否可管理使用者帳號（核准 / 停用；僅管理員）。 */
export function canManageUsers(user: AppUser | null): boolean {
  return isAdmin(user);
}

/**
 * 是否可使用**業務管理系統**（首頁、業務、屬性、公版、小工具說明）。
 *
 * 「解鎖專用」帳號一律不行——那是給各分隊申請解鎖用的最低權限帳號，
 * 不需要也不應該看到科內業務（使用者 2026-08-06 指定）。
 */
export function canUseTaskSystem(user: AppUser | null): boolean {
  // 管理員一律放行：管理員身分來自 email 白名單，萬一文件的 role 欄位被改壞
  // （或誤設成 unlocker），也不能把唯一能改回來的人鎖在外面。
  return isAdmin(user) || (isApproved(user) && user?.role !== 'unlocker');
}

/** 是否可使用解鎖工單（三種角色只要已核准都可以）。 */
export function canUseUnlockRequests(user: AppUser | null): boolean {
  return isApproved(user);
}

/**
 * 是否為「只能解鎖」的帳號。
 *
 * 用來決定登入後要落在哪一頁：這種帳號進任何業務頁都會被導回解鎖工單頁。
 */
export function isUnlockOnly(user: AppUser | null): boolean {
  return canUseUnlockRequests(user) && !canUseTaskSystem(user);
}

/**
 * 是否看得到**所有人**的解鎖工單。
 *
 * 管理員與一般使用者要看得到全部（他們才是實際去跑解鎖的人）；
 * 解鎖專用帳號只看得到自己送出的那幾筆。
 */
export function canSeeAllUnlockRequests(user: AppUser | null): boolean {
  return canUseTaskSystem(user);
}
