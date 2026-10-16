/**
 * 「取消其他子系統權限」的純函式測試。
 *
 * 為什麼特別測這裡：`resolveClearCodes` 一旦放過 MCI，就是把整個機關的大傷權限
 * 一起拿掉；`planSubsystemClear` 把「讀不到」當成「沒有權限」，那個人就會安靜地保有權限。
 *
 * ⚠ 這裡的資料全是為了測試而編的，不是真實資料。
 *
 * 執行：npm run tool:mci:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAR_OTHERS } from './config.mjs';
import { describeSnapshots, displayNameOf, planSubsystemClear, resolveClearCodes } from './otherSubsystems.mjs';

test('設定檔裡的取消清單與保留清單沒有交集，而且是 10 個', () => {
  const codes = resolveClearCodes(CLEAR_OTHERS.clearCodes, CLEAR_OTHERS.keepCodes);
  assert.equal(codes.length, 10);
  for (const keep of ['MCI', 'ACS', 'DQC']) assert.ok(!codes.includes(keep), `${keep} 不該在取消清單裡`);
});

test('FOS 在系統裡的 id 是 VDS，取消清單用的是 VDS', () => {
  assert.ok(CLEAR_OTHERS.clearCodes.includes('VDS'));
  assert.ok(!CLEAR_OTHERS.clearCodes.includes('FOS'));
  assert.match(displayNameOf('VDS'), /^FOS/);
});

test('取消清單碰到要保留的子系統就丟錯（大小寫不同也一樣）', () => {
  assert.throws(() => resolveClearCodes(['ATM', 'mci'], ['MCI', 'ACS', 'DQC']), /mci/);
  assert.throws(() => resolveClearCodes([], ['MCI']), /空的/);
});

test('取消清單重複寫的會併成一個', () => {
  assert.deepEqual(resolveClearCodes(['ATM', 'ATM', ' AAM '], ['MCI']), ['ATM', 'AAM']);
});

test('有勾的才要取消；沒勾、下拉是「請選擇權限」的不動', () => {
  const plan = planSubsystemClear([
    { code: 'ATM', found: true, checked: true, role: 'ATM003 一般使用者' },
    { code: 'ADG', found: true, checked: false, role: '請選擇權限' },
    { code: 'AAM', found: true, checked: true, role: 'AAM003 縣市端使用者' },
  ]);
  assert.deepEqual(plan.toClear.map((item) => item.code), ['ATM', 'AAM']);
  assert.equal(plan.unreadable.length, 0);
  assert.equal(plan.roleWithoutCheck.length, 0);
});

test('讀不到的子系統不會被當成「沒有權限」', () => {
  const plan = planSubsystemClear([
    { code: 'ATM', found: false, checked: false, role: '' },
    { code: 'ADG', found: true, checked: false, role: '請選擇權限' },
  ]);
  assert.deepEqual(plan.unreadable.map((item) => item.code), ['ATM']);
  assert.equal(plan.toClear.length, 0);
});

test('沒勾但下拉顯示角色的另外記下來，不算要取消', () => {
  const plan = planSubsystemClear([{ code: 'DSM', found: true, checked: false, role: 'DSM002 縣市端使用者' }]);
  assert.equal(plan.toClear.length, 0);
  assert.deepEqual(plan.roleWithoutCheck.map((item) => item.code), ['DSM']);
});

test('給人看的說明用系統代號＋原本的角色', () => {
  const text = describeSnapshots([
    { code: 'VDS', found: true, checked: true, role: 'VDS001 縣市端管理者' },
    { code: 'ATM', found: true, checked: true, role: '' },
  ]);
  assert.equal(text, 'FOS（VDS001 縣市端管理者）、ATM（沒有選）');
});
