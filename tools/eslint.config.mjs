/**
 * 小工具（`tools/` 底下）的靜態檢查設定，只開 `no-undef` 一條規則。
 *
 * 為什麼只開這一條：單元測試只驗各個函式，不會走到 `index.mjs` 的 `main()`，
 * 「呼叫了卻不存在的函式」要等使用者按下 .bat 才會爆。2026-10-05 就踩過——
 * `copyHowToFile()` 被誤刪，交通案件、月度報表、心電圖統計整整一個月都一啟動就失敗
 * （見 docs/TOOLS_SPEC.md 1.8「實跑踩過的坑」）。這條規則不必執行程式就抓得到。
 *
 * 由 `npm run tool:lint` 執行，各工具的 `tool:*:test` 會先跑它。
 */
import globals from 'globals';

/**
 * 只在 `page.evaluate()` 等瀏覽器端程式碼裡出現的名稱。
 *
 * 刻意逐一列出、不整包開放 `globals.browser`：那一包有一千多個名稱，
 * 包含 `name`、`status`、`close` 這類常見字，打錯變數名時會被當成合法而放過。
 * 新的瀏覽器端程式碼用到清單外的名稱時，確認是在瀏覽器裡執行的再補進來。
 */
const BROWSER_SIDE_GLOBALS = ['document', 'window', 'location', 'CSS', 'Image', 'Node']
  .reduce((acc, name) => ({ ...acc, [name]: 'readonly' }), {});

export default [
  {
    ignores: ['**/out/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...BROWSER_SIDE_GLOBALS },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
