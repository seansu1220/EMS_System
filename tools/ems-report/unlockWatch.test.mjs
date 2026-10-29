/**
 * 常駐監看的測試（注入替身，不開瀏覽器、不連網路）。
 *
 * 這裡釘住的是幾件會在「無人看管時」出錯的事：
 *   1. 沒有工單時不可以去動救護系統
 *   2. 試跑模式看到工單也不可以處理
 *   3. 雲端讀不到不可以讓整個監看死掉
 *   4. 心跳發現掉線時要重新登入
 *   5. 收到結束指示要停得下來
 *   6. 跨夜之後查詢期間要跟著往前走（不然當天的案件會全變成「查無案件」）
 *   7. 每次剛登入後都要重置一輪卡住的裝置（開啟時、掉線重新登入後）
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUnlockWatch, refreshQueryRange, isHandledOutcome } from './unlockWatch.mjs';
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
  const calls = { fetch: 0, batch: 0, heartbeat: 0, ensure: 0, reset: [] };
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
      resetDevices: async (_session, options) => {
        calls.reset.push(options.dryRun);
        // 模擬「做完一台」：讓監看有機會穿插處理解鎖申請。
        if (overrides.simulateDevice && options.betweenDevices) {
          calls.betweenResult = await options.betweenDevices();
        }
        return null;
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
    resetDevices: async () => null,
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

test('跨夜之後查詢期間的迄日要跟著變成新的今天', () => {
  // 2026-09-10 使用者回報：監看視窗 9/9 打開後放著跨夜，
  // 9/10 送出的申請被判成「查無案件」——因為期間的迄日還停在 9/9。
  const session = {};
  const yesterday = refreshQueryRange(session, new Date(2026, 8, 9, 23, 50));
  assert.equal(yesterday.end, '2026-09-09');

  const today = refreshQueryRange(session, new Date(2026, 8, 10, 0, 10));
  assert.equal(today.end, '2026-09-10', '過了午夜就要用新的今天當迄日');
  assert.equal(today.start, '2026-07-10', '起日同樣往前推，維持「近兩個月」的長度');
  assert.equal(session.range.end, '2026-09-10', '算出來的期間要寫回 session');
});

test('同一天之內重複呼叫，查詢期間不會亂跳', () => {
  const session = {};
  const first = refreshQueryRange(session, new Date(2026, 8, 10, 8, 0));
  const second = refreshQueryRange(session, new Date(2026, 8, 10, 17, 30));
  assert.deepEqual(second, first);
});

test('兩條解鎖路徑的成功狀態都算「真的處理到了」', () => {
  // 漏掉任何一個的後果：那一筆會被當成「看起來失敗」去多做一次登入檢查，
  // 檢查沒過就退回待處理且不寫結果——但事情已經做了，而且不可復原。
  assert.equal(isHandledOutcome('已解鎖'), true, '按「調整為未結案」那條路');
  assert.equal(isHandledOutcome('已解除佔用'), true, '刪線上使用佔用那條路（2026-09-11 漏過）');
  assert.equal(isHandledOutcome('無需處理'), true, '兩邊都沒事也是正常結局');
});

test('看起來失敗的狀態要留著被登入檢查攔下', () => {
  // 這幾種都可能只是「根本沒登入」造成的假象，不可以直接寫成失敗。
  for (const status of ['查無案件', '需人工處理', '失敗']) {
    assert.equal(isHandledOutcome(status), false, status + ' 必須再確認一次登入');
  }
});

test('試跑才有的狀態不算處理到了（監看一律正式模式，出現它們代表有別的問題）', () => {
  assert.equal(isHandledOutcome('已定位'), false);
  assert.equal(isHandledOutcome('已定位佔用'), false);
});

test('監看一開啟就先重置一輪卡住的裝置，試跑時只回報', async () => {
  const live = createSpies();
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: false, shouldStop: stopAfter(2) }, live.deps));
  assert.deepEqual(live.calls.reset, [false], '開啟時做一輪，之後沒重新登入就不再做');

  const dry = createSpies();
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: stopAfter(2) }, dry.deps));
  assert.deepEqual(dry.calls.reset, [true], '試跑模式要以試跑去檢查，不可以真的動手');
});

test('掉線後重新登入，要再重置一輪卡住的裝置', async () => {
  const spies = createSpies({ alive: false, loginResult: () => '重新登入' });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 0, reloginWaitMs: 0 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: false, shouldStop: stopAfter(2) }, spies.deps));
  assert.ok(spies.calls.reset.length >= 2, `開啟一次＋重新登入後一次，實際 ${spies.calls.reset.length} 次`);
});

test('處理工單前發現要重新登入，登入後先重置裝置再處理', async () => {
  const spies = createSpies({
    requests: (round) => (round === 1 ? [{ id: 'r1', temsis: 'T115070100001' }] : []),
    loginResult: () => '重新登入',
  });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: false, shouldStop: stopAfter(2) }, spies.deps));
  assert.deepEqual(spies.calls.reset, [false, false], '開啟時一次、處理前重新登入後一次');
  assert.equal(spies.calls.batch, 1);
});

test('重置裝置途中有新的解鎖申請，先處理申請', async () => {
  const spies = createSpies({
    // 第 1 次查雲端發生在重置途中（開啟時那一輪），之後沒有新的。
    requests: (round) => (round === 1 ? [{ id: 'r1', temsis: 'T115070100001' }] : []),
    simulateDevice: true,
  });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: false, shouldStop: stopAfter(1) }, spies.deps));
  assert.equal(spies.calls.batch, 1, '重置途中的申請要先處理，不能等整輪做完');
  assert.equal(spies.calls.betweenResult, true, '處理過申請要告訴重置流程畫面被帶走了');
});

test('重置裝置途中沒有新申請時，不去動解鎖流程', async () => {
  const spies = createSpies({ simulateDevice: true });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: false, shouldStop: stopAfter(1) }, spies.deps));
  assert.equal(spies.calls.batch, 0);
  assert.equal(spies.calls.betweenResult, false);
});

test('試跑模式重置裝置時不穿插處理申請', async () => {
  const spies = createSpies({ requests: () => [{ id: 'r1', temsis: 'T115070100001' }], simulateDevice: true });
  await withWatchTiming({ pollMs: 0, heartbeatMs: 60 * 60 * 1000 }, () =>
    runUnlockWatch(createSession(), {}, { dryRun: true, shouldStop: stopAfter(1) }, spies.deps));
  assert.equal(spies.calls.betweenResult, undefined, '試跑不按任何鈕，不需要穿插');
  assert.equal(spies.calls.batch, 0);
});
