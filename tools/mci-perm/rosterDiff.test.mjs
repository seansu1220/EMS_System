import assert from 'node:assert/strict';
import test from 'node:test';
import { differsByOneChar, diffRosters, normalizeUnit, unitsCompatible } from './rosterDiff.mjs';

/** 測試用假名單（全部是虛構姓名）。 */
const person = (unit, name) => ({ unit, name, lineNumber: 1 });

test('保留名單沒有同名者 → 取消；有同名同單位 → 保留', () => {
  const all = [person('大溪分隊', '王小明'), person('大溪分隊', '陳大文')];
  const keep = [person('大溪分隊', '王小明')];
  const diff = diffRosters(all, keep);
  assert.deepEqual(diff.kept.map((entry) => entry.name), ['王小明']);
  assert.deepEqual(diff.toRevoke.map((entry) => entry.name), ['陳大文']);
  assert.equal(diff.keepUnmatched.length, 0);
});

test('單位寫法不同但互相包含，算同一個單位', () => {
  assert.equal(unitsCompatible('大溪分隊', '第三救災救護大隊大溪分隊'), true);
  assert.equal(unitsCompatible('桃園市政府消防局緊急救護科', '緊急救護科'), true);
  assert.equal(normalizeUnit(' 桃園市政府消防局 大溪分隊 '), '大溪分隊');
  const diff = diffRosters([person('第三救災救護大隊大溪分隊', '王小明')], [person('大溪分隊', '王小明')]);
  assert.equal(diff.kept.length, 1);
  assert.equal(diff.toRevoke.length, 0);
});

test('同名但單位對不上 → 存疑不動，不會被取消', () => {
  const diff = diffRosters([person('龍潭分隊', '王小明')], [person('大溪分隊', '王小明')]);
  assert.equal(diff.toRevoke.length, 0);
  assert.equal(diff.unitConflicts.length, 1);
  assert.deepEqual(diff.unitConflicts[0].keepUnits, ['大溪分隊']);
  // 保留名單那位已經在存疑裡講過了，不必再列成「找不到」。
  assert.equal(diff.keepUnmatched.length, 0);
});

test('姓名只差一個字、單位對得上 → 疑似抄錯字，不會被取消', () => {
  const diff = diffRosters([person('大溪分隊', '王曉明')], [person('大溪分隊', '王小明')]);
  assert.equal(diff.toRevoke.length, 0);
  assert.equal(diff.typoSuspects.length, 1);
  assert.equal(diff.typoSuspects[0].keepEntry.name, '王小明');
  assert.equal(diff.keepUnmatched.length, 0);
});

test('只差一個字但單位不同，不算抄錯字（照樣取消）', () => {
  const diff = diffRosters([person('龍潭分隊', '王曉明')], [person('大溪分隊', '王小明')]);
  assert.deepEqual(diff.toRevoke.map((entry) => entry.name), ['王曉明']);
  assert.deepEqual(diff.keepUnmatched.map((entry) => entry.name), ['王小明']);
});

test('姓名裡的空白不影響比對', () => {
  const diff = diffRosters([person('大溪分隊', '王 小 明')], [person('大溪分隊', '王小明')]);
  assert.equal(diff.kept.length, 1);
});

test('differsByOneChar：長度不同或差兩個字都不算', () => {
  assert.equal(differsByOneChar('王小明', '王曉明'), true);
  assert.equal(differsByOneChar('王小明', '王小明'), false);
  assert.equal(differsByOneChar('王小明', '李曉明'), false);
  assert.equal(differsByOneChar('王小明', '王明'), false);
  assert.equal(differsByOneChar('王', '李'), false);
});

test('保留名單有、全部名單沒有的人列在 keepUnmatched', () => {
  const diff = diffRosters([person('大溪分隊', '王小明')], [person('大溪分隊', '王小明'), person('平鎮分隊', '林美玲')]);
  assert.deepEqual(diff.keepUnmatched.map((entry) => entry.name), ['林美玲']);
});
