/**
 * 值班監看主迴圈的測試。
 *
 * 整個迴圈碰外部世界的事情都可以注入替身，因此這一組**完全離線**：
 * 不開瀏覽器、不連雲端、不等真實時間。
 *
 * 這裡最重要的一條是「**兩邊互不影響**」——救護系統的解鎖是天天在用的功能，
 * 不能因為新加的一站通掉線或出錯就跟著停擺。
 *
 * 執行：npm run tool:duty:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WATCH } from './config.mjs';
import { clock, describeDuration, foldBatches, runDutyWatch } from './dutyLoop.mjs';

/** 不出聲的 log，順便把訊息收下來供斷言。 */
function makeLog() {
  const lines = [];
  const push = (text) => lines.push(String(text));
  return {
    lines,
    step: push,
    info: push,
    ok: push,
    warn: push,
    fail: (stage, error) => push(`${stage}:${error?.message ?? error}`),
  };
}

/**
 * 組出一組可控的測試環境。
 *
 * @param {object} config
 * @param {number} config.rounds 跑幾輪就停
 * @param {number} [config.tickMs] 每一輪讓時間前進多久（用來觸發心跳）
 */
function makeHarness(config) {
  const log = makeLog();
  const calls = {
    unlockHeartbeat: 0,
    mciHeartbeat: 0,
    processUnlocks: 0,
    processRoster: [],
    ensureUnlock: 0,
    ensureMci: 0,
  };
  let clockMs = 0;
  let round = 0;

  const state = {
    unlockAlive: config.unlockAlive ?? true,
    mciAlive: config.mciAlive ?? true,
    unlockSignIn: config.unlockSignIn ?? '已登入',
    mciSignIn: config.mciSignIn ?? '重新登入',
    pendingUnlocks: config.pendingUnlocks ?? [],
    rosterLines: config.rosterLines ?? [],
  };

  const sides = {
    unlockSide: {
      key: 'unlock',
      name: '救護系統',
      heartbeat: async () => {
        calls.unlockHeartbeat += 1;
        return state.unlockAlive;
      },
      ensureSignedIn: async () => {
        calls.ensureUnlock += 1;
        return state.unlockSignIn;
      },
    },
    mciSide: {
      key: 'mci',
      name: '一站通',
      heartbeat: async () => {
        calls.mciHeartbeat += 1;
        return state.mciAlive;
      },
      ensureSignedIn: async () => {
        calls.ensureMci += 1;
        return state.mciSignIn;
      },
    },
  };

  const deps = {
    log,
    beep: () => {},
    now: () => clockMs,
    sleep: async () => {
      clockMs += config.tickMs ?? 1000;
    },
    takeRosterLines: () => {
      const lines = state.rosterLines;
      state.rosterLines = [];
      return lines;
    },
    parseRoster: (lines) => ({
      entries: lines.filter(Boolean).map((line, index) => ({
        unit: line.split(',')[0],
        name: line.split(',')[1] ?? '',
        lineNumber: index + 1,
      })),
      problems: [],
      duplicateCount: 0,
    }),
    fetchPendingUnlocks: async () => {
      const requests = state.pendingUnlocks;
      state.pendingUnlocks = [];
      return requests;
    },
    processUnlocks: async (requests) => {
      calls.processUnlocks += 1;
      return { done: requests.length, requeued: 0 };
    },
    processRoster: async (entries, options) => {
      calls.processRoster.push({ count: entries.length, execute: options.execute });
      return entries;
    },
  };

  const options = {
    dryRun: config.dryRun ?? false,
    shouldStop: () => round++ >= config.rounds,
  };

  return { sides, options, deps, calls, log, state };
}

test('空行代表這一批貼完了', () => {
  const collecting = [];
  const ready = foldBatches(collecting, ['大溪分隊,測試甲', '中壢分隊,測試乙', '']);
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0], ['大溪分隊,測試甲', '中壢分隊,測試乙']);
  assert.equal(collecting.length, 0);
});

test('還沒按空白行之前，名單留在手上不處理', () => {
  const collecting = [];
  assert.deepEqual(foldBatches(collecting, ['大溪分隊,測試甲']), []);
  assert.equal(collecting.length, 1);
});

test('一次貼上多批也分得開', () => {
  const collecting = [];
  const ready = foldBatches(collecting, ['甲隊,一', '', '乙隊,二', '丙隊,三', '']);
  assert.equal(ready.length, 2);
  assert.deepEqual(ready[1], ['乙隊,二', '丙隊,三']);
});

test('沒在收集時的空行只是隨手按 Enter，不算一批', () => {
  const collecting = [];
  assert.deepEqual(foldBatches(collecting, ['', '', '']), []);
});

test('沒事發生時不會去動任何一個系統', async () => {
  const harness = makeHarness({ rounds: 2 });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processUnlocks, 0);
  assert.equal(harness.calls.processRoster.length, 0);
  assert.equal(harness.calls.unlockHeartbeat, 0); // 還沒到心跳時間
});

test('貼完一批名單就會處理，而且只處理一次', async () => {
  const harness = makeHarness({ rounds: 3, rosterLines: ['大溪分隊,測試甲', ''] });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processRoster.length, 1);
  assert.equal(harness.calls.processRoster[0].count, 1);
});

test('試跑時開通不會按確定（execute 傳 false）', async () => {
  const harness = makeHarness({ rounds: 2, dryRun: true, rosterLines: ['大溪分隊,測試甲', ''] });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processRoster[0].execute, false);
});

test('正式模式開通才會按確定', async () => {
  const harness = makeHarness({ rounds: 2, dryRun: false, rosterLines: ['大溪分隊,測試甲', ''] });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processRoster[0].execute, true);
});

test('有工單就處理', async () => {
  const harness = makeHarness({ rounds: 2, pendingUnlocks: [{ id: 'a' }, { id: 'b' }] });
  const result = await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processUnlocks, 1);
  assert.equal(result.unlocked, 2);
});

test('試跑模式看到工單也不處理，讓它們留在待處理', async () => {
  const harness = makeHarness({ rounds: 2, dryRun: true, pendingUnlocks: [{ id: 'a' }] });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processUnlocks, 0);
});

test('雲端讀不到時不可以讓監看整個死掉', async () => {
  const harness = makeHarness({ rounds: 2 });
  harness.deps.fetchPendingUnlocks = async () => {
    throw new Error('網路暫時斷了');
  };
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.ok(harness.log.lines.some((line) => line.includes('查不到雲端工單')));
});

test('開通中途出錯不會中斷值班，另一邊照常', async () => {
  const harness = makeHarness({
    rounds: 3,
    rosterLines: ['大溪分隊,測試甲', ''],
    pendingUnlocks: [{ id: 'a' }],
  });
  harness.deps.processRoster = async () => {
    throw new Error('那一頁壞了');
  };
  const result = await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.ok(harness.log.lines.some((line) => line.includes('那一頁壞了')));
  assert.equal(result.unlocked, 1); // 解鎖那邊完全不受影響
});

test('時間到了才戳系統維持登入，而且兩邊各戳各的', async () => {
  const harness = makeHarness({ rounds: 3, tickMs: WATCH.heartbeatMs + 1000 });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.ok(harness.calls.unlockHeartbeat >= 1);
  assert.ok(harness.calls.mciHeartbeat >= 1);
});

test('一站通掉線時，救護系統照常處理工單', async () => {
  const harness = makeHarness({
    rounds: 4,
    tickMs: WATCH.heartbeatMs + 1000,
    mciAlive: false, // 一站通心跳失敗＝被踢掉
    mciSignIn: '等不到', // 而且使用者沒回來登入
    pendingUnlocks: [{ id: 'a' }],
  });
  const result = await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(result.unlocked, 1, '救護系統這邊不該被一站通掉線影響');
  assert.ok(harness.log.lines.some((line) => line.includes('一站通') && line.includes('登入已被伺服器結束')));
});

test('掉線那一邊沒人來登入，值班也不會自己結束', async () => {
  const harness = makeHarness({
    rounds: 3,
    tickMs: WATCH.heartbeatMs + 1000,
    unlockAlive: false,
    unlockSignIn: '等不到',
  });
  // 跑完設定的輪數才停，代表迴圈沒有因為掉線而提早離開。
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.ok(harness.calls.ensureUnlock >= 1);
});

test('掉線期間收到的名單會留著，登入後才處理', async () => {
  const harness = makeHarness({
    rounds: 2,
    tickMs: WATCH.heartbeatMs + 1000,
    mciAlive: false,
    mciSignIn: '等不到',
    rosterLines: ['大溪分隊,測試甲', ''],
  });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processRoster.length, 0, '沒登入時不該去點系統');
});

test('只顧一邊時，另一邊完全不會被碰到', async () => {
  const harness = makeHarness({ rounds: 2, tickMs: WATCH.heartbeatMs + 1000, pendingUnlocks: [{ id: 'a' }] });
  await runDutyWatch({ unlockSide: harness.sides.unlockSide, mciSide: null }, harness.options, harness.deps);
  assert.equal(harness.calls.mciHeartbeat, 0);
  assert.equal(harness.calls.processRoster.length, 0);
});

test('收到結束指示就停得下來', async () => {
  const harness = makeHarness({ rounds: 0 });
  await runDutyWatch(harness.sides, harness.options, harness.deps);
  assert.equal(harness.calls.processUnlocks, 0);
  assert.ok(harness.log.lines.some((line) => line.includes('停止值班')));
});

test('把時間說成人話', () => {
  assert.equal(describeDuration(90 * 1000), '1 分鐘');
  assert.equal(describeDuration(3 * 3600 * 1000 + 25 * 60 * 1000), '3 小時 25 分');
});

test('時間戳是兩位數的時分', () => {
  assert.equal(clock(new Date(2026, 7, 18, 9, 5)), '09:05');
});
