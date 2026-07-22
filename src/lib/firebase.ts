/**
 * Firebase 初始化。
 *
 * 設定值由環境變數（.env）注入，避免把金鑰寫死在程式中。
 * 請複製 .env.example 為 .env 並填入 Firebase 主控台「專案設定 → 你的應用程式」的設定碼。
 */
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

/** 從環境變數讀取的 Firebase 設定。 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// 啟動前檢查設定是否齊全，缺漏時給出明確錯誤而非靜默失敗。
const missingKeys = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingKeys.length > 0) {
  throw new Error(
    `Firebase 設定不完整，缺少：${missingKeys.join(', ')}。` +
      '請確認專案根目錄的 .env 已依 .env.example 填妥並重新啟動 dev server。',
  );
}

const app = initializeApp(firebaseConfig);

/** Firebase Authentication 實例。 */
export const auth = getAuth(app);

/** Firestore 資料庫實例。 */
export const db = getFirestore(app);

export default app;
