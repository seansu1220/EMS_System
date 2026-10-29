/**
 * 裝置管理重置的判斷規則測試（純函式，不開瀏覽器）。
 *
 * 釘住的是「哪幾台該動、哪幾台絕對不能動」：
 *   1. 只挑狀態是「持續取得資料」的
 *   2. 認不出唯一一列、或沒有鎖定鈕的不動（鎖了找不回來就會停在管理者停用）
 *   3. 台數多時照樣全部處理（2026-10-29 實際有 133 台，原本的 20 台上限已拿掉）
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickStuckDevices,
  statusMatches,
  describeDevice,
  describeDeviceClickRefusal,
  estimateMinutes,
} from './deviceReset.mjs';
import { UNLOCK } from './config.mjs';

const { statusValues } = UNLOCK.deviceReset;

/** 造一列假的掃描結果（預設是一台可以處理的卡住裝置）。 */
function makeRow(overrides = {}) {
  return {
    rowIndex: 1,
    fingerprint: 'abc',
    unique: true,
    status: '持續取得資料',
    label: '中路分隊',
    idTail: '3B12',
    buttons: { lock: true, enable: true },
    ...overrides,
  };
}

test('只挑狀態是「持續取得資料」的裝置', () => {
  const rows = [
    makeRow({ rowIndex: 1 }),
    makeRow({ rowIndex: 2, fingerprint: 'b', status: '管理者停用' }),
    makeRow({ rowIndex: 3, fingerprint: 'c', status: '正常' }),
  ];
  const picked = pickStuckDevices({ rows }, statusValues);
  assert.deepEqual(picked.targets.map((row) => row.rowIndex), [1]);
  assert.equal(picked.skipped.length, 0);
});

test('認不出唯一一列的不動：鎖了之後找不回它，裝置就會停在管理者停用', () => {
  const picked = pickStuckDevices({ rows: [makeRow({ unique: false })] }, statusValues);
  assert.equal(picked.targets.length, 0);
  assert.equal(picked.skipped.length, 1);
});

test('那一列沒有鎖定鈕時不動，並說明原因', () => {
  const picked = pickStuckDevices(
    { rows: [makeRow({ buttons: { lock: false, enable: true } })] }, statusValues);
  assert.equal(picked.targets.length, 0);
  assert.match(picked.skipped[0].why, /鎖定/);
});

test('台數多時照樣全部處理（實際有 133 台）', () => {
  const rows = Array.from({ length: 133 }, (_, index) => makeRow({ rowIndex: index + 1, fingerprint: `f${index}` }));
  assert.equal(pickStuckDevices({ rows }, statusValues).targets.length, 133);
});

test('預估時間：無條件進位到分鐘，至少 1 分鐘', () => {
  assert.equal(estimateMinutes(133, 25000), 56);
  assert.equal(estimateMinutes(1, 25000), 1);
  assert.equal(estimateMinutes(0, 25000), 1);
});

test('狀態比對忽略空白，且是「包含」比對', () => {
  assert.equal(statusMatches(' 持續 取得資料 ', statusValues.stuck), true);
  assert.equal(statusMatches('管理者停用', statusValues.stuck), false);
  assert.equal(statusMatches('', statusValues.disabled), false);
  assert.equal(statusMatches(null, statusValues.disabled), false);
});

test('指稱某一台時帶分隊與裝置ID 末 4 碼，讀不到分隊也講得出是第幾列', () => {
  assert.equal(describeDevice(makeRow({ rowIndex: 7 })), '第 7 列（中路分隊，裝置ID 末4碼 3B12）');
  assert.equal(describeDevice(makeRow({ label: null, idTail: null })), '第 1 列（讀不到單位）');
});

test('每一種沒動手的理由都翻得成人話', () => {
  for (const reason of ['noTable', 'notFound', 'notUnique', 'statusChanged', 'noButton', undefined]) {
    assert.ok(describeDeviceClickRefusal(reason).length > 0);
  }
});
