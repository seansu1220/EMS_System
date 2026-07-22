/**
 * 使用者相關型別。
 * 對應 Firestore `users/{uid}` 文件。單一使用者系統，不含角色權限欄位。
 */

/** 應用程式內的使用者資料。 */
export interface AppUser {
  /** Firebase Auth 的 uid，同時作為文件 ID。 */
  uid: string;
  /** 電子郵件。 */
  email: string;
  /** 顯示名稱。 */
  displayName: string;
  /** 建立時間（ISO 字串）。 */
  createdAt: string;
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
