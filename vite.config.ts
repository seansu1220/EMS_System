import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

// 由 package.json 取版本號，並在建置當下記錄建置時間，
// 於編譯期注入為全域常數（供 UI 顯示，用於確認是否載入到最新版本）。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
const buildTime = new Date().toISOString();

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true, // 允許區域網路內其他裝置（手機/平板）連線測試
    headers: {
      // 讓 Google 登入彈出視窗能正常運作（避免 COOP 封鎖 window.closed/close）
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
});
