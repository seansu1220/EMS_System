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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  waitForAppReady,
  loadSessionState,
  saveSessionState,
  clearSessionState,
  tryReuseSession,
} from './session.mjs';
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

// --- 登入狀態的保存與沿用 ---------------------------------------------------

/** 每個測試用自己的暫存檔，彼此不干擾，也絕不碰到真正的 .auth/state.json。 */
async function withTempStateFile(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-session-'));
  try {
    await run(path.join(dir, 'state.json'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 假的 BrowserContext：storageState({ path }) 就是把 JSON 寫到該路徑。 */
function createFakeContext(state) {
  return {
    async storageState({ path: filePath }) {
      await fs.writeFile(filePath, JSON.stringify(state), 'utf8');
      return state;
    },
  };
}

test('saveSessionState 存下來的內容，loadSessionState 讀得回來', async () => {
  await withTempStateFile(async (filePath) => {
    const state = { cookies: [{ name: 'JSESSIONID', value: 'x' }], origins: [] };
    await saveSessionState(createFakeContext(state), filePath);
    assert.deepEqual(await loadSessionState(filePath), state);
  });
});

test('saveSessionState 會自動建立不存在的資料夾', async () => {
  await withTempStateFile(async (filePath) => {
    const nested = path.join(path.dirname(filePath), '.auth', 'state.json');
    await saveSessionState(createFakeContext({ cookies: [] }), nested);
    assert.deepEqual(await loadSessionState(nested), { cookies: [] });
  });
});

test('loadSessionState 檔案不存在時回傳 null（第一次跑的正常情況）', async () => {
  await withTempStateFile(async (filePath) => {
    assert.equal(await loadSessionState(filePath), null);
  });
});

test('loadSessionState 超過保存期限就不沿用', async () => {
  await withTempStateFile(async (filePath) => {
    await saveSessionState(createFakeContext({ cookies: [] }), filePath);
    // 把修改時間往回撥兩小時，模擬「上次登入是很久以前」。
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(filePath, twoHoursAgo, twoHoursAgo);
    assert.equal(await loadSessionState(filePath, 60 * 60 * 1000), null, '超過期限要回 null');
    assert.notEqual(await loadSessionState(filePath, 3 * 60 * 60 * 1000), null, '期限內要讀得到');
  });
});

test('loadSessionState 內容毀損時回傳 null 而不是拋錯', async () => {
  await withTempStateFile(async (filePath) => {
    await fs.writeFile(filePath, '{ 這不是 JSON', 'utf8');
    assert.equal(await loadSessionState(filePath), null);
  });
});

test('clearSessionState 刪得掉，且檔案不存在時不會出錯', async () => {
  await withTempStateFile(async (filePath) => {
    await saveSessionState(createFakeContext({ cookies: [] }), filePath);
    await clearSessionState(filePath);
    assert.equal(await loadSessionState(filePath), null);
    await clearSessionState(filePath); // 再刪一次也不該拋錯
  });
});

/**
 * 假 page：可指定哪些 frame 有驗證碼欄位（代表登入頁還在），以及有哪些 frame。
 */
function createFakeSessionPage({ captchaInFrames = [], frameNames = [''] }) {
  return {
    frames() {
      return frameNames.map((name) => ({
        name: () => name,
        locator(selector) {
          const hasCaptcha = selector === SITE.loginFields.captcha && captchaInFrames.includes(name);
          return { async count() { return hasCaptcha ? 1 : 0; } };
        },
      }));
    },
    async waitForTimeout() {},
  };
}

test('tryReuseSession 登入頁還在就判定沿用失敗', async () => {
  const page = createFakeSessionPage({ captchaInFrames: [''], frameNames: [''] });
  assert.equal(await tryReuseSession(page, 1000), false);
});

test('tryReuseSession 沒有登入頁且主畫面建得起來就判定成功', async () => {
  const page = createFakeSessionPage({
    frameNames: ['', 'header', SITE.frames.sideMenu, SITE.frames.content],
  });
  assert.equal(await tryReuseSession(page, 1000), true);
});

test('tryReuseSession 主畫面等不到時回傳 false 而不是拋錯', async () => {
  // 沒有登入頁，但 frameset 也永遠建不起來（例如被導到錯誤頁）→ 應安靜退回正常登入。
  const page = createFakeSessionPage({ frameNames: ['', 'header'] });
  assert.equal(await tryReuseSession(page, 800), false);
});
