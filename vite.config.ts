import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
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
