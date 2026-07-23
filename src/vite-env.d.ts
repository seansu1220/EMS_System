/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 建置期由 vite.config.ts 注入：應用程式版本號（取自 package.json）。 */
declare const __APP_VERSION__: string;
/** 建置期由 vite.config.ts 注入：建置時間（ISO 字串）。 */
declare const __BUILD_TIME__: string;
