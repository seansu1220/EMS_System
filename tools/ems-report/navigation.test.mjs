/**
 * 導航的等待邏輯測試。
 *
 * 這裡守的是 2026-08-09 那個真實事故：點完左側選單後，程式在 0.05 秒內就宣告
 * 「已經到查詢頁了」，於是把查詢期間與 TEMSIS 填進**即將被換掉的舊頁面**，
 * 隨後新頁面抵達、欄位全被洗成空白，查詢自然什麼都查不到，
 * 結果被回報成「這個案件查無資料」。
 *
 * 用假的 page／frame 而不是真的開瀏覽器：要驗的是「等到了沒」這個判斷，
 * 與真實網站無關，且真實網站需要驗證碼，無法自動化。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gotoRecordQuery, gotoMenuItem } from './navigation.mjs';
import { SITE } from './config.mjs';

/**
 * 假的目標系統：只模擬「換頁需要時間」這件事。
 *
 * 刻意讓內容框的網址**從一開始就已經是查詢頁的網址**——這正是事故當下的狀態
 * （前一次操作就停在這一頁），也是舊版只比對網址會誤判的原因。
 */
function createFakeSystem({ navDelayMs = 300, menuFound = true, formArrives = true } = {}) {
  const system = {
    now: 0,
    stamp: null,
    contentUrl: `https://example.test/ActionControlServlet?APname=${SITE.apNames.recordQuery}`,
    /** 舊頁面本身就是一張可以填的查詢表單。 */
    formReady: true,
    /** 換頁排程的抵達時刻；null 代表目前沒有換頁在路上。 */
    arrivesAt: null,
    /** 從蓋上記號之後，文件被換過幾次。 */
    replacements: 0,
    menuFound,
  };

  system.advance = (ms) => {
    system.now += ms;
    if (system.arrivesAt !== null && system.now >= system.arrivesAt) {
      system.arrivesAt = null;
      system.stamp = null; // 新文件的 window 是全新的，一定沒有記號
      system.formReady = formArrives;
      system.replacements += 1;
    }
  };
  system.startNavigation = () => {
    system.arrivesAt = system.now + navDelayMs;
    system.formReady = false; // 換頁途中舊表單已經不算數了
  };
  return system;
}

function createFakePage(system) {
  const contentFrame = {
    name: () => SITE.frames.content,
    url: () => system.contentUrl,
    async evaluate(_fn, arg) {
      // 有帶參數＝蓋記號；沒帶＝讀記號（讀不到記號時回傳 null）。
      if (arg !== undefined) {
        system.stamp = arg;
        return undefined;
      }
      return system.stamp ?? null;
    },
    locator(selector) {
      return {
        count: async () => (system.formReady && selector === SITE.queryFields.dateFrom ? 1 : 0),
      };
    },
    async goto() {
      system.startNavigation();
      // 直接載入網址是同步等到 domcontentloaded 才回來的，這裡等價地讓它立刻抵達。
      system.advance(1000);
    },
  };
  const sideMenuFrame = {
    name: () => SITE.frames.sideMenu,
    url: () => 'https://example.test/sidemenu.jsp',
    async evaluate() {
      if (!system.menuFound) return false;
      system.startNavigation();
      return true;
    },
  };
  return {
    frames: () => [contentFrame, sideMenuFrame],
    async waitForTimeout(ms) {
      system.advance(ms);
    },
    async waitForLoadState() {},
  };
}

test('gotoRecordQuery 會等到新頁面真的抵達才回傳（網址原本就相同也不會提早放行）', async () => {
  const system = createFakeSystem({ navDelayMs: 300 });
  const route = await gotoRecordQuery(createFakePage(system));

  assert.equal(route, '左側選單連結');
  assert.equal(system.replacements, 1, '必須確實等到文件被換過一次');
  assert.ok(system.now >= 300, `應至少等滿換頁時間，實際只等了 ${system.now}ms`);
  assert.equal(system.formReady, true, '回傳時查詢表單必須已經在畫面上');
});

test('gotoRecordQuery 在查詢欄位遲遲沒出現時中止，不會硬填一張還沒載好的表單', async () => {
  const system = createFakeSystem({ navDelayMs: 300, formArrives: false });
  await assert.rejects(
    () => gotoRecordQuery(createFakePage(system), { formReadyTimeoutMs: 500 }),
    /查詢條件欄位/,
  );
});

test('gotoRecordQuery 點不到選單時改走直接載入網址的備援', async () => {
  const system = createFakeSystem({ menuFound: false });
  const route = await gotoRecordQuery(createFakePage(system));

  assert.equal(route, '直接載入網址（備援）');
  assert.equal(system.formReady, true);
});

test('gotoMenuItem 也要等到內容框換頁，不能只看網址有沒有變', async () => {
  const system = createFakeSystem({ navDelayMs: 500 });
  await gotoMenuItem(createFakePage(system), '案件列表', { settleMs: 0 });

  assert.equal(system.replacements, 1);
  assert.ok(system.now >= 500, `應至少等滿換頁時間，實際只等了 ${system.now}ms`);
});
