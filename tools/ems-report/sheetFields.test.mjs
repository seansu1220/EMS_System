/**
 * 救護紀錄表欄位擷取的測試（純函式，不需要瀏覽器）。
 *
 * 測資一律使用**虛構的編號**，不放任何真實個案資料。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLabeledCode,
  extractLabeledValue,
  listSheetLabels,
  isSameCode,
  maskCode,
} from './sheetFields.mjs';

test('extractLabeledCode 取得標籤後面的編號', () => {
  const text = '救災救護指揮中心指派案號：1150701000123\n姓名：某某某';
  const result = extractLabeledCode(text, ['救災救護指揮中心指派案號']);
  assert.equal(result?.value, '1150701000123');
});

test('extractLabeledCode 容許標籤與值之間有換行與空白（PDF 常見）', () => {
  const text = '救災救護指揮中心\n指派案號\n\n   1150701000123   ';
  const result = extractLabeledCode(text, ['救災救護指揮中心指派案號']);
  assert.equal(result?.value, '1150701000123');
});

test('extractLabeledCode 依候選順序比對，找不到就往下一個試', () => {
  const text = '指派案號 ： AB-1234567';
  const result = extractLabeledCode(text, ['救災救護指揮中心指派案號', '指派案號']);
  assert.equal(result?.value, 'AB-1234567');
  assert.equal(result?.label, '指派案號');
});

test('extractLabeledCode 找不到標籤時回傳 null，不亂猜', () => {
  assert.equal(extractLabeledCode('這張表上沒有那個欄位', ['指派案號']), null);
  assert.equal(extractLabeledCode('', ['指派案號']), null);
});

test('extractLabeledCode 標籤後面沒有編號時回傳 null', () => {
  // 只有中文沒有編號，代表版面與預期不同，寧可回報找不到也不要抓錯值。
  assert.equal(extractLabeledCode('指派案號：（空白）', ['指派案號']), null);
});

test('extractLabeledCode 同一標籤出現多次時，取第一個後面真的有編號的', () => {
  const text = '指派案號：\n（本頁續）指派案號：1150701000999';
  assert.equal(extractLabeledCode(text, ['指派案號'])?.value, '1150701000999');
});

test('isSameCode 忽略空白與分隔符號', () => {
  assert.ok(isSameCode('115-0701 000123', '1150701000123'));
  assert.ok(isSameCode('t1150701', 'T1150701'));
});

test('isSameCode 不同編號要判定為不同，空值一律不相等', () => {
  assert.ok(!isSameCode('1150701000123', '1150701000124'));
  assert.ok(!isSameCode('', ''));
  assert.ok(!isSameCode(null, undefined));
});

test('maskCode 只留末 4 碼', () => {
  assert.equal(maskCode('1150701000123'), '*********0123');
  assert.equal(maskCode('123'), '***');
  assert.equal(maskCode(''), '(空白)');
});

test('extractLabeledValue 取得非編號的值（例如車輛名稱）', () => {
  const text = '出勤車輛：桃園91\n受理時間：2026/07/02 10:10:03';
  assert.equal(extractLabeledValue(text, ['出勤車輛'])?.value, '桃園91');
  assert.equal(extractLabeledValue(text, ['受理時間'])?.value, '2026/07/02 10:10:03');
});

test('extractLabeledValue 找不到標籤時回傳 null', () => {
  assert.equal(extractLabeledValue('這張表沒有那一欄', ['出勤車輛']), null);
});

test('listSheetLabels 有冒號時只列出欄位名稱，不把值帶出來', () => {
  const labels = listSheetLabels('出勤車輛：桃園91\n受理時間：2026/07/02\n姓名：某某某');
  assert.deepEqual(labels, ['出勤車輛', '受理時間', '姓名']);
  assert.ok(!labels.join('').includes('桃園'), '有冒號可用時就不該啟用會混入值的備援樣式');
});

test('listSheetLabels 沒有冒號時寧可什麼都不給，也不猜', () => {
  // 曾試過「中文詞後面接數字」的備援樣式，但它抓到的是值（「桃園」）而不是欄位名，
  // 既不可靠又可能帶出內容，因此刻意不做。
  assert.deepEqual(listSheetLabels('受理時間 2026/07/02 出勤車輛 桃園91'), []);
});
