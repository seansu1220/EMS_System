/**
 * 登入流程輔助函式的測試（用假的 page 物件，不需真的開瀏覽器）。
 *
 * 這組測試的重點不只是行為正確，更是要**實際執行到函式內部**：
 * 語法檢查（node --check）抓不到「用了沒 import 的常數」這類錯誤，
 * 只有真的跑過該函式才會顯現（曾因此在實跑時才爆 APP_READY_TIMEOUT_MS is not defined）。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAppReady } from './session.mjs';
import { SITE } from './config.mjs';

/** 造一個最小的假 page：只需要 frames() 與 waitForTimeout()。 */
function createFakePage(frameNameSets) {
  let callCount = 0;
  return {
    frames() {
      const names = frameNameSets[Math.min(callCount, frameNameSets.length - 1)];
      return names.map((name) => ({ name: () => name }));
    },
    async waitForTimeout() {
      callCount += 1;
    },
  };
}

test('waitForAppReady 等到必要的 frame 出現才回傳', async () => {
  const page = createFakePage([
    [''], // 第一次只有主文件（登入剛送出，frameset 還沒建好）
    ['', 'header'], // 建到一半
    ['', 'header', SITE.frames.sideMenu, SITE.frames.content], // 完成
  ]);
  await waitForAppReady(page, 5000);
});

test('waitForAppReady 逾時的錯誤訊息要說明缺了什麼', async () => {
  const page = createFakePage([['', 'header']]);
  await assert.rejects(() => waitForAppReady(page, 1200), (error) => {
    assert.match(error.message, /主畫面載入逾時/);
    assert.match(error.message, new RegExp(SITE.frames.sideMenu), '要列出缺少的 frame');
    assert.match(error.message, /header/, '要列出目前有哪些 frame');
    return true;
  });
});

test('waitForAppReady 使用預設逾時常數時不會出錯', async () => {
  // 只驗證「有帶預設值且該常數存在」，故意讓它立刻成功以免真的等 60 秒。
  const page = createFakePage([['', SITE.frames.sideMenu, SITE.frames.content]]);
  await waitForAppReady(page);
});
