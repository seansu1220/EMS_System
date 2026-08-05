/**
 * 線上解鎖工單的測試（純函式與回寫邏輯，不連雲端、不開瀏覽器）。
 *
 * 這裡釘住的是**兩端之間的契約**：本機這一端算出來的狀態，
 * 必須是網頁那一端看得懂的那幾個字串（見 `src/types/unlockRequest.ts`）。
 * 對不上的話網頁會顯示成不明狀態，而且是靜悄悄地錯。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toQueueStatus } from './unlockQueue.mjs';
import { runUnlockFlow } from './unlock.mjs';

test('解鎖成功對應到網頁的「已解鎖」', () => {
  assert.equal(toQueueStatus('已解鎖'), 'unlocked');
});

test('本來就沒鎖對應到「本來就沒鎖」，不可以算成失敗', () => {
  // 網頁上這兩種要分得出來：一個是做完了，一個是根本不用做，都不是出問題。
  assert.equal(toQueueStatus('無需處理'), 'noAction');
});

test('需人工處理、查無案件、失敗，對申請人來說都是「需人工處理」', () => {
  for (const status of ['需人工處理', '查無案件', '失敗']) {
    assert.equal(toQueueStatus(status), 'failed', `${status} 應該對應 failed`);
  }
});

test('沒見過的狀態一律當成失敗，不可以誤報成已解鎖', () => {
  assert.equal(toQueueStatus('某個新狀態'), 'failed');
});

/** 造一個假 session：解鎖流程只會用到 context 與 page，這裡都不會真的被碰到。 */
function createFlowSession() {
  return { context: {}, page: {} };
}

const RANGE = { start: '2026-06-01', end: '2026-08-06', label: '近兩個月' };

test('每解完一筆就回報一次，不是等整批跑完才一起回報', async () => {
  // 中途關掉視窗時，前面做完的幾筆在網頁上才不會停在「待處理」。
  const events = [];
  await runUnlockFlow(createFlowSession(), {
    temsisList: ['T1', 'T2'],
    range: RANGE,
    dryRun: true,
    onCaseStart: (temsis) => events.push(`start:${temsis}`),
    onCaseDone: (outcome) => events.push(`done:${outcome.temsis}`),
  });
  // 第一筆要「開始→完成」都回報完，才輪到第二筆開始。
  assert.deepEqual(events, ['start:T1', 'done:T1', 'start:T2', 'done:T2']);
});

test('回寫雲端失敗不可以中斷解鎖流程', async () => {
  // 案件已經解了，雲端寫不寫得進去是另一回事——不能因此讓剩下幾筆都不跑。
  const done = [];
  const outcomes = await runUnlockFlow(createFlowSession(), {
    temsisList: ['T1', 'T2'],
    range: RANGE,
    dryRun: true,
    onCaseDone: (outcome) => {
      done.push(outcome.temsis);
      throw new Error('網路斷了');
    },
  });
  assert.equal(outcomes.length, 2, '兩筆都要跑完');
  assert.deepEqual(done, ['T1', 'T2']);
});

test('沒有給回呼時照常運作（一般的 unlock 指令就是這樣用）', async () => {
  const outcomes = await runUnlockFlow(createFlowSession(), {
    temsisList: ['T1'],
    range: RANGE,
    dryRun: true,
  });
  assert.equal(outcomes.length, 1);
});
