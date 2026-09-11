/**
 * 線上使用狀況（第二種解鎖路徑）的判斷規則測試。
 *
 * 這裡測的是 `decideUsageAction`——「掃描結果該不該動手」的那組規則。
 * 為什麼值得單獨測：刪錯一列無法復原，而這組規則正是唯一擋在刪除前面的東西；
 * 埋在一堆 await 中間的話，只有實跑才驗得到，而實跑不可能為了測試去刪真的資料。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideUsageAction, describeClickRefusal } from './onlineUsage.mjs';

/** 一列「完全正常、可以刪」的掃描結果。 */
function goodRow(overrides = {}) {
  return { hasButton: true, buttonSelfIdentifies: true, rowIndex: 3, values: {}, ...overrides };
}

/** 包成 `findRowsByColumnValue` 的回傳形狀。 */
function scan(matches, overrides = {}) {
  return { found: true, headers: ['項次', 'TEMSIS ID'], matches, scanned: 28, ...overrides };
}

test('剛好一列相符、按鈕齊全且自帶編號 → 可以刪', () => {
  const decision = decideUsageAction(scan([goodRow()]));
  assert.equal(decision.action, 'delete');
});

test('清單裡沒有這筆 → 這筆真的不用處理，不是卡住', () => {
  const decision = decideUsageAction(scan([]));
  assert.equal(decision.action, 'none');
});

test('兩列都是同一個 TEMSIS → 不動手，交給人', () => {
  // 任何選擇都是猜的，而猜錯就是把別人的紀錄刪掉。
  const decision = decideUsageAction(scan([goodRow(), goodRow({ rowIndex: 9 })]));
  assert.equal(decision.action, 'manual');
  assert.match(decision.why, /2 列/);
});

test('找到那一列，但那一列裡沒有刪除按鈕 → 不動手', () => {
  // 絕不可以退而求其次去按別列的按鈕——那正是「刪錯排」的典型成因。
  const decision = decideUsageAction(scan([goodRow({ hasButton: false })]));
  assert.equal(decision.action, 'manual');
});

test('按鈕的 onclick 沒自帶這組 TEMSIS → 不動手', () => {
  // 可能是系統換了傳值方式，也可能根本對到別列；分不出是哪一種時一律不動。
  const decision = decideUsageAction(scan([goodRow({ buttonSelfIdentifies: false })]));
  assert.equal(decision.action, 'manual');
  assert.match(decision.why, /自帶/);
});

test('連 TEMSIS 欄都找不到 → 當成版面改了，交給人，不可當成「沒有這筆」', () => {
  // 這兩件事必須分開：讀不到欄位是「不知道」，不是「沒有」。
  // 混為一談的話，版面一改，每一筆都會被回報成「不需要處理」而靜靜漏掉。
  const decision = decideUsageAction({ found: false, matches: [], scanned: 0 });
  assert.equal(decision.action, 'manual');
  assert.match(decision.why, /找不到 TEMSIS 欄/);
});

test('每一種沒動手的理由都講得出人話，不會漏成 undefined', () => {
  for (const reason of ['notFound', 'notUnique', 'noButton', 'buttonMismatch']) {
    const text = describeClickRefusal(reason);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${reason} 應該要有說明`);
    assert.ok(!text.includes('undefined'), `${reason} 的說明不該出現 undefined`);
  }
  // 沒預期到的理由也要有話可說，不能讓使用者看到空白。
  assert.match(describeClickRefusal('somethingNew'), /somethingNew/);
});
