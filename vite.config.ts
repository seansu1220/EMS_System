import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cpSync, readFileSync } from 'node:fs';

// 由 package.json 取版本號，並在建置當下記錄建置時間，
// 於編譯期注入為全域常數（供 UI 顯示，用於確認是否載入到最新版本）。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
const buildTime = new Date().toISOString();

// pdf.js 讀檔要用的資源（中文字型對照表、標準字型、掃描檔影像解碼器、色彩描述檔）
// 每次啟動開發伺服器或建置時，從 node_modules 複製到 public/pdfjs/（已 gitignore），
// 版本永遠跟著已安裝的 pdfjs-dist。少了這些，未內嵌中文字型的 PDF 會整頁空白。
const PDFJS_RESOURCE_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
for (const dir of PDFJS_RESOURCE_DIRS) {
  try {
    cpSync(new URL(`./node_modules/pdfjs-dist/${dir}`, import.meta.url), new URL(`./public/pdfjs/${dir}`, import.meta.url), {
      recursive: true,
    });
  } catch (error) {
    throw new Error(`複製 pdf.js 資源「${dir}」失敗（vite.config.ts）：${(error as Error).message}`);
  }
}

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
