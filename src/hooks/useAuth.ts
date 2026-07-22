/** 取用驗證狀態的 hook。 */
import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from '../context/authContext';

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth 必須在 <AuthProvider> 內使用。');
  }
  return context;
}
