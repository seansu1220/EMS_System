/**
 * 使用者相關型別。
 * 對應 Firestore `users/{uid}` 文件。
 * 多人共用同一批業務資料，以「角色 + 帳號狀態」控管權限（v1.8 起）。
 */

/**
 * 使用者角色。
 * - admin：管理員（email 在白名單內），可核准帳號、刪除業務。
 * - member：一般使用者，可新增/編輯業務，不可刪除業務。
 */
export type UserRole = 'admin' | 'member';

/**
 * 帳號狀態。
 * - pending：已註冊、等待管理員核准，尚不可進入系統。
 * - approved：正式帳號，可使用系統。
 * - rejected：管理員未通過（或已停用），不可進入系統。
 */
export type UserStatus = 'pending' | 'approved' | 'rejected';

/** 應用程式內的使用者資料。 */
export interface AppUser {
  /** Firebase Auth 的 uid，同時作為文件 ID。 */
  uid: string;
  /** 電子郵件。 */
  email: string;
  /** 顯示名稱。 */
  displayName: string;
  /** 角色（依 email 白名單決定，見 lib/permissions.ts）。 */
  role: UserRole;
  /** 帳號狀態（由管理員核准/拒絕）。 */
  status: UserStatus;
  /** 建立時間（ISO 字串）。 */
  createdAt: string;
  /** 狀態最後異動時間（ISO 字串）；尚未審核為 null。 */
  reviewedAt: string | null;
  /** 審核者 uid；尚未審核為 null。 */
  reviewedBy: string | null;
}

/** 登入輸入。 */
export interface LoginInput {
  email: string;
  password: string;
}

/** 註冊輸入。 */
export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}
