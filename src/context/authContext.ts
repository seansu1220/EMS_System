/**
 * 驗證狀態的 React Context 定義。
 * 與 Provider 分離，方便 hook 引用且不影響 Fast Refresh。
 */
import { createContext } from 'react';
import type { AppUser } from '../types/user';

export interface AuthContextValue {
  /** 目前登入者的應用程式資料；未登入為 null。 */
  user: AppUser | null;
  /** 是否仍在判斷登入狀態（初次載入）。 */
  loading: boolean;
  /** 重新載入目前使用者的資料（例如改名後刷新顯示）。 */
  refreshUser: () => Promise<void>;
  /** 目前使用者是否為管理員（可刪除業務、管理帳號）。 */
  isAdmin: boolean;
  /** 目前帳號是否已核准可使用系統。 */
  isApproved: boolean;
  /**
   * 是否可使用業務管理系統（首頁、業務、屬性、公版、小工具）。
   * 「解鎖專用」角色為 false——那種帳號只進得去解鎖工單頁。
   */
  canUseTasks: boolean;
  /** 是否為「只能解鎖」的帳號（登入後直接落在解鎖工單頁）。 */
  isUnlockOnly: boolean;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
