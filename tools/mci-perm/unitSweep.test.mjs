/**
 * 單位掃描的純函式測試（「全面取消」最不能出錯的一步）。
 *
 * 為什麼特別測這裡：`splitUnits` 少留一個單位，就是把不該動的人的權限拿掉了；
 * 而那是這個工具唯一真的會出事的錯誤。
 *
 * ⚠ 這裡的單位與姓名全是為了測試而編的，不是真實資料。
 *
 * 執行：npm run tool:mci:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEntriesByUnit, filterUnits, splitUnits } from './unitSweep.mjs';

/** 仿照真實下拉：第一個是「請選擇」（沒有 value），其餘是科室與分隊。 */
const OPTIONS = [
  { value: '', text: '請選擇' },
  { value: 'A1', text: '緊急救護科' },
  { value: 'B1', text: '測試甲分隊' },
  { value: 'B2', text: '測試乙分隊' },
  { value: 'B3', text: '測試乙分隊第二救護隊' },
];

test('「請選擇」不會被當成一個單位', () => {
  const { targets, ignored } = splitUnits(OPTIONS, ['緊急救護科']);
  assert.equal(ignored.length, 1);
  assert.ok(!targets.some((option) => option.text === '請選擇'));
});

test('保留單位不會出現在要清空的名單裡', () => {
  const { targets, kept } = splitUnits(OPTIONS, ['緊急救護科']);
  assert.deepEqual(kept.map((option) => option.text), ['緊急救護科']);
  assert.deepEqual(targets.map((option) => option.text), ['測試甲分隊', '測試乙分隊', '測試乙分隊第二救護隊']);
});

test('保留單位用「包含」比對，寫一部分也認得', () => {
  const { kept } = splitUnits(OPTIONS, ['救護科']);
  assert.deepEqual(kept.map((option) => option.text), ['緊急救護科']);
});

test('保留單位的空白寫法不影響比對', () => {
  // 系統的選項有時會多一個全形空白，那不該讓「要保留的單位」漏掉。
  const spaced = [{ value: 'A1', text: '緊急　救護科' }, ...OPTIONS.slice(2)];
  const { kept } = splitUnits(spaced, ['緊急救護科']);
  assert.equal(kept.length, 1);
});

test('保留單位可以有好幾個', () => {
  const { targets, kept } = splitUnits(OPTIONS, ['緊急救護科', '測試甲分隊']);
  assert.equal(kept.length, 2);
  assert.deepEqual(targets.map((option) => option.text), ['測試乙分隊', '測試乙分隊第二救護隊']);
});

test('沒有指定保留單位時，kept 是空的（呼叫端要據此停手）', () => {
  // index.mjs 會在 kept 為空時直接丟錯，不繼續跑——
  // 那通常代表單位名稱寫錯，繼續跑等於把本來要留的單位也一起清掉。
  const { kept } = splitUnits(OPTIONS, ['不存在的科']);
  assert.equal(kept.length, 0);
});

test('沒有 value 的選項一律略過（選了等於沒選）', () => {
  const { targets } = splitUnits([{ value: '', text: '全部' }, { value: '0', text: '不限' }], []);
  assert.equal(targets.length, 0);
});

test('--unit 只留下名稱相符的單位', () => {
  const { targets } = splitUnits(OPTIONS, ['緊急救護科']);
  assert.deepEqual(filterUnits(targets, '測試甲').map((option) => option.text), ['測試甲分隊']);
});

test('--unit 相符的不只一個時全部保留（由使用者自己看清單）', () => {
  const { targets } = splitUnits(OPTIONS, ['緊急救護科']);
  assert.equal(filterUnits(targets, '測試乙').length, 2);
});

test('--unit 留空時等於不過濾', () => {
  const { targets } = splitUnits(OPTIONS, ['緊急救護科']);
  assert.equal(filterUnits(targets, '').length, targets.length);
});

test('沿用舊名單時，--unit 也要篩得掉別的單位的人', () => {
  // 舊名單是全機關的人。不在這裡再篩一次，「只想先試一個單位」的指令
  // 就會變成把全部的人都跑掉。
  const entries = [
    { unit: '測試甲分隊', name: '測試甲', lineNumber: 0 },
    { unit: '測試乙分隊', name: '測試乙', lineNumber: 0 },
  ];
  assert.deepEqual(filterEntriesByUnit(entries, '測試甲').map((entry) => entry.name), ['測試甲']);
  assert.equal(filterEntriesByUnit(entries, '').length, 2, '留空等於不過濾');
  assert.equal(filterEntriesByUnit(entries, '不存在').length, 0);
});
