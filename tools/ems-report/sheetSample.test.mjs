/**
 * 紀錄表取樣遮蔽的測試：重點是**病患資料一個字都不能留下來**。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSample, maskSample, sameTextRatio, toShape } from './sheetSample.mjs';

/** 造一段文字。 */
const item = (str, x, y, page = 1) => ({ page, x, y, width: 10, height: 10, str, hasEOL: false });

test('形狀符號：中文〇、數字9、英文a，標點照留', () => {
  assert.equal(toShape('王小明 A123456789 10:38'), '〇〇〇 a999999999 99:99');
});

test('每一份都有的字（表格標籤）保留；不一樣的整段遮掉', () => {
  const first = [item('姓名', 10, 700), item('王小明', 60, 700)];
  const second = [item('姓名', 10, 700), item('李大華', 60, 700)];
  const masked = maskSample(first, [second]);
  assert.equal(masked[0].str, '姓名');
  assert.equal(masked[0].kept, 'same');
  assert.equal(masked[1].str, '〇〇〇');
});

test('標籤與值在同一段時，只留到分隔符號：同姓也不可以留下姓氏', () => {
  const first = [item('姓名：陳小明', 10, 700)];
  const second = [item('姓名：陳大華', 10, 700)];
  assert.equal(maskSample(first, [second])[0].str, '姓名：〇〇〇');
});

test('這一份是別份的一部分（王小 vs 王小明）時整段遮掉，不可原樣保留', () => {
  const first = [item('王小', 60, 700)];
  const second = [item('王小明', 60, 700)];
  assert.equal(maskSample(first, [second])[0].str, '〇〇');
});

test('對不到同位置的那一段時整段遮掉', () => {
  const masked = maskSample([item('A123456789', 60, 600)], [[item('B987654321', 300, 100)]]);
  assert.equal(masked[0].str, 'a999999999');
  assert.equal(masked[0].kept, 'masked');
});

test('要跟每一份都相同才保留：三份中有一份不同就遮', () => {
  const masked = maskSample([item('王小明', 60, 700)], [[item('王小明', 60, 700)], [item('李大華', 60, 700)]]);
  assert.equal(masked[0].str, '〇〇〇');
});

test('兩份一樣的文字比例（只供參考）', () => {
  const sheet = [item('姓名', 10, 700), item('王小明', 60, 700)];
  assert.equal(sameTextRatio(sheet, sheet), 1);
});

test('結構檔：依座標排成一列一列，也列出現行的切行', () => {
  const masked = maskSample(
    [item('姓名', 10, 700), item('王小明', 60, 700), { ...item('血壓', 10, 680), hasEOL: true }],
    [[item('姓名', 10, 700), item('李大華', 60, 700), item('血壓', 10, 680)]],
  );
  const text = formatSample(masked, '測試');
  assert.match(text, /y=700\t10:姓名　｜　60:〇〇〇/);
  assert.match(text, /照現行比對程式的切行/);
  assert.doesNotMatch(text, /王小明/);
});
