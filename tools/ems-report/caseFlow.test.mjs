/**
 * 案件層級共用操作的測試。
 *
 * 守的是 2026-10-05 未結案統整實跑抓到的事：案件列表一打開就先列出 30 筆最近的案件，
 * 按下查詢後若結果頁還沒換上來就往下讀，讀到的是那 30 筆，再「取第一列」就會點到別件案子。
 * 兩道防線各測一次：按查詢要等到新文件、點之前要比對案號。
 *
 * 用假的 page／frame：要驗的是「有沒有等」與「挑哪一列」的判斷，與真實網站無關。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchCaseRows, submitQuery } from './caseFlow.mjs';
import { SITE } from './config.mjs';

/** 假的內容框：按下查詢後要過 `reloadDelayMs` 才換成新文件（記號才會消失）。 */
function createFakeQueryPage({ reloadDelayMs }) {
  const system = { now: 0, stamp: null, arrivesAt: null, replacements: 0 };
  const advance = (ms) => {
    system.now += ms;
    if (system.arrivesAt !== null && system.now >= system.arrivesAt) {
      system.arrivesAt = null;
      system.stamp = null;
      system.replacements += 1;
    }
  };
  const contentFrame = {
    name: () => SITE.frames.content,
    url: () => 'https://example.test/ActionControlServlet',
    async evaluate(_fn, arg) {
      if (arg !== undefined) {
        system.stamp = arg;
        return undefined;
      }
      return system.stamp ?? null;
    },
    locator(selector) {
      return {
        count: async () => (selector === SITE.queryFields.queryButton ? 1 : 0),
        click: async () => {
          system.arrivesAt = system.now + reloadDelayMs;
        },
      };
    },
  };
  const page = {
    frames: () => [contentFrame],
    async waitForTimeout(ms) {
      advance(ms);
    },
    async waitForLoadState() {},
  };
  return { system, page };
}

test('submitQuery 要等到結果頁真的換上來，查詢再慢也不能提早往下讀', async () => {
  // 刻意比舊版的固定緩衝（1.5 秒）慢很多：舊版在這裡會讀到查詢前的畫面。
  const { system, page } = createFakeQueryPage({ reloadDelayMs: 8000 });
  await submitQuery(page);

  assert.equal(system.replacements, 1, '必須確實等到內容框換過一次文件');
  assert.ok(system.now >= 8000, `應至少等滿結果頁回來的時間，實際只等了 ${system.now}ms`);
});

test('matchCaseRows 只挑案號相符的列，查詢前那 30 筆裡沒有就回空的', () => {
  const stale = Array.from({ length: 30 }, (_, index) => `11509300000${String(index).padStart(2, '0')}`);
  assert.deepEqual(matchCaseRows(stale, '1150930999915'), { matched: [], readable: true });

  assert.deepEqual(matchCaseRows(['A1', 'A2', 'A3'], 'A2'), { matched: [1], readable: true });
  assert.deepEqual(matchCaseRows(['A2', null, 'a2'], 'A2'), { matched: [0, 2], readable: true }, '大小寫不同仍是同一號');
});

test('matchCaseRows 一列都讀不到案號時標成讀不到，交給呼叫端決定（不猜）', () => {
  assert.deepEqual(matchCaseRows([null, null], 'A1'), { matched: [], readable: false });
});
