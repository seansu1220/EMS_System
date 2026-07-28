/**
 * 增減資料來源（Google 試算表）的解析測試。
 * 只測純函式，不連網。執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, describeSheet } from './adjustSheet.mjs';

test('parseCsv 處理引號、逗號與跨行儲存格', () => {
  const csv = '日期,分隊,原因\n2026-06-01,桃園分隊,"備註,含逗號"\n2026-06-02,大林分隊,"換行\n測試"\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['日期', '分隊', '原因']);
  assert.equal(rows[1][2], '備註,含逗號', '引號內的逗號不可當成欄位分隔');
  assert.equal(rows[2][2], '換行\n測試', '引號內的換行不可當成換列');
});

test('parseCsv 處理逸出的雙引號並略過全空白列', () => {
  const rows = parseCsv('a,b\n"說""引號""",2\n,\n \n');
  assert.deepEqual(rows[1], ['說"引號"', '2']);
  assert.equal(rows.length, 2, '全空白的列要略過');
});

test('describeSheet 推測欄位型態且不輸出任何內容', () => {
  const rows = [
    ['案發日期', '出勤單位', '件數'],
    ['2026-06-01 08:30', '桃園分隊', '1'],
    ['2026-06-02 09:15', '大林分隊', '1'],
    ['2026-06-03 10:00', '桃園分隊', '1'],
  ];
  const info = describeSheet(rows);

  assert.equal(info.rowCount, 4);
  assert.equal(info.columnCount, 3);
  assert.deepEqual(info.columns[0].kinds, ['日期', '時間']);
  assert.deepEqual(info.columns[1].kinds, ['分隊名稱']);
  assert.deepEqual(info.columns[2].kinds, ['數字']);
  assert.equal(info.columns[1].distinct, 2);

  const serialized = JSON.stringify(info);
  assert.ok(!serialized.includes('桃園分隊'), '診斷資訊不可含任何儲存格內容');
  assert.ok(!serialized.includes('2026-06-01'), '診斷資訊不可含任何儲存格內容');
});
