/**
 * 常駐監看的測試（注入替身，不開瀏覽器、不連網路）。
 *
 * 這裡釘住的是幾件會在「無人看管時」出錯的事：
 *   1. 沒有工單時不可以去動救護系統
 *   2. 試跑模式看到工單也不可以處理
 *   3. 雲端讀不到不可以讓整個監看死掉
 *   4. 心跳發現掉線時要重新登入
 *   5. 收到結束指示要停得下來
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUnlockWatch } from './unlockWatch.mjs';
import { UNLOCK } from './config.mjs';

/** 假的工作階段：只需要一個能被等待的 page。 */
function createSession() {
  return {
    page: { waitForTimeout: async () => {} },
    context: {},
    range: { start: '2026-06-01', end: '2026-08-06', label: '近兩個月' },
  };
}

/** 跑 N 輪就停。 */
function stopAfter(rounds) {
  let count = 0;
  return () => count++ >= rounds;
}

/** 收集替身被呼叫的情形。 */
function createSpies(overrides = {}) {
  const calls = { fetch: 0, batch: 0, heartbeat: 0, ensure: 0 };
  return {
    calls,
    deps: {
      fetchPending: async () => {
        calls.fetch += 1;
        return overrides.requests?.(calls.fetch) ?? [];
      },
      processBatch: async () => {
        calls.batch += 1;
        return { done: 1, requeued: 0 };
      },
      heartbeat: async () => {
        calls.heartbeat += 1;
        return overrides.alive ?? true;
      },
      ensureSignedIn: async () => {
        calls.ensure += 1;
        return overrides.loginResult?.(calls.ensure) ?? '已登入';
      },
    },
  };
}

/** 暫時改掉監看節奏，跑完復原。 */
async function withWatchTiming(timing, run) {
  const original = { ...UNLOCK.watch };
  Object.assign(UNLOCK.watch, timing);
  try {
    await run();
  } finally {
    Object.assign(UNLOCK.watch, original);
  }
}

test('沒有工單時不會去動救護系統', async () => {
  const spies = createSpies();
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: false, shouldStop: stopAfter(3) }, spies.deps));
  assert.equal(spies.calls.fetch, 3, '每一輪都要查一次雲端');
  assert.equal(spies.calls.batch, 0, '沒有工單就不該處理');
  assert.equal(spies.calls.heartbeat, 0, '心跳時間還沒到就不該戳系統');
});

test('有工單時先確認還登入著，再處理', async () => {
  const spies = createSpies({
    requests: (round) => (round === 1
      ? [{ id: 'r1', temsis: 'T115070100001', reason: '補登', requestedByName: '蘆竹分隊' }]
      : []),
  });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: false, shouldStop: stopAfter(2) }, spies.deps));
  assert.equal(spies.calls.ensure, 1, '動手之前要先確認登入狀態');
  assert.equal(spies.calls.batch, 1);
});

test('試跑模式看到工單也不處理，讓它們留在待處理', async () => {
  const spies = createSpies({
    requests: () => [{ id: 'r1', temsis: 'T115070100001', reason: '補登', requestedByName: '蘆竹分隊' }],
  });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: stopAfter(2) }, spies.deps));
  assert.equal(spies.calls.batch, 0, '試跑不可以處理任何工單');
  assert.equal(spies.calls.ensure, 0, '試跑連登入都不必確認');
});

test('雲端讀不到時不可以讓監看整個死掉', async () => {
  const calls = { fetch: 0 };
  const deps = {
    fetchPending: async () => {
      calls.fetch += 1;
      throw new Error('網路暫時斷了');
    },
    processBatch: async () => ({ done: 0, requeued: 0 }),
    heartbeat: async () => true,
    ensureSignedIn: async () => true,
  };
  // 沒有拋出例外就代表撐過去了，而且後面幾輪照跑。
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: stopAfter(3) }, deps));
  assert.equal(calls.fetch, 3);
});

test('心跳時間到了就戳一次系統維持登入', async () => {
  const spies = createSpies();
  await withWatchTiming({ pollMs: 0, heartbeatMs: 0 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: stopAfter(2) }, spies.deps));
  assert.equal(spies.calls.heartbeat, 2, '每一輪都該心跳（間隔設為 0）');
});

test('心跳發現掉線時要重新登入', async () => {
  const spies = createSpies({ alive: false });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 0 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: stopAfter(2) }, spies.deps));
  assert.ok(spies.calls.ensure >= 1, '掉線就要請使用者重新登入');
});

test('掉線後沒人來登入，監看不可以自己結束——要一直等', async () => {
  // 2026-08-06 實際踩到：凌晨 06:53 掉線時使用者在睡覺，
  // 舊版等 10 分鐘就讓整個程式退出，早上看到的是一個已經死掉的視窗。
  const spies = createSpies({ alive: false, loginResult: () => '等不到' });
  await withWatchTiming(
    { pollMs: 0, heartbeatMs: 0, reloginWaitMs: 0, reloginRemindEveryMs: 60 * 60 * 1000 },
    () => runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: stopAfter(5) }, spies.deps),
  );
  // 每一輪都要再試一次登入，而且不可以跑去查雲端（沒登入什麼都不能做）。
  assert.ok(spies.calls.ensure >= 3, `應該反覆嘗試重新登入，實際 ${spies.calls.ensure} 次`);
});

test('等到使用者回來登入之後，要繼續正常監看', async () => {
  let attempts = 0;
  const spies = createSpies({
    alive: false,
    // 第 1 次等不到、第 2 次成功。
    loginResult: () => (++attempts === 1 ? '等不到' : '重新登入'),
  });
  await withWatchTiming(
    { pollMs: 0, heartbeatMs: 60 * 60 * 1000, reloginWaitMs: 0, reloginRemindEveryMs: 0 },
    () => runUnlockWatch(
      { page: { waitForTimeout: async () => {} }, context: {}, range: {} },
      {},
      { dryRun: true, shouldStop: stopAfter(4) },
      { ...spies.deps, heartbeat: async () => false },
    ),
  );
  assert.ok(spies.calls.fetch > 0, '重新登入之後要恢復查詢雲端工單');
});

test('收到結束指示就停得下來，不會再去查雲端', async () => {
  const spies = createSpies();
  await runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: () => true }, spies.deps);
  assert.equal(spies.calls.fetch, 0);
});
