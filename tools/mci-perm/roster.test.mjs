/**
 * 名單解析的單元測試。
 *
 * ⚠ 這裡的姓名全是為了測試而編的，不是真實人員。
 *
 * 執行：npm run tool:mci:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRosterLocation,
  detectDroppedFiles,
  parseRoster,
  parseRosterLine,
  parseRosterMatrix,
} from './roster.mjs';

test('逗號、tab、空白都當成單位與姓名的分隔', () => {
  assert.deepEqual(parseRosterLine('大溪分隊,測試甲'), { unit: '大溪分隊', name: '測試甲' });
  assert.deepEqual(parseRosterLine('大溪分隊\t測試甲'), { unit: '大溪分隊', name: '測試甲' });
  assert.deepEqual(parseRosterLine('大溪分隊 測試甲'), { unit: '大溪分隊', name: '測試甲' });
  assert.deepEqual(parseRosterLine('大溪分隊，測試甲'), { unit: '大溪分隊', name: '測試甲' });
});

test('只切一刀：姓名裡的分隔符不會再被切開', () => {
  // 原住民姓名常見這種寫法，切多刀會把名字砍掉一半。
  assert.deepEqual(parseRosterLine('復興分隊,測試·乙'), { unit: '復興分隊', name: '測試·乙' });
});

test('只有姓名時用 .env 的預設單位', () => {
  assert.deepEqual(parseRosterLine('測試甲', { defaultUnit: '中壢分隊' }), {
    unit: '中壢分隊',
    name: '測試甲',
  });
});

test('空行不算問題，直接略過', () => {
  const result = parseRoster(['大溪分隊,測試甲', '', '   ', '中壢分隊,測試乙']);
  assert.equal(result.entries.length, 2);
  assert.equal(result.problems.length, 0);
});

test('連標題一起貼上時，標題列會被認出來並略過', () => {
  const result = parseRoster(['單位\t姓名', '大溪分隊\t測試甲']);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['測試甲'],
  );
});

test('沒有單位又沒有預設單位時列為問題，不硬猜', () => {
  const result = parseRoster(['測試甲']);
  assert.equal(result.entries.length, 0);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].reason, /沒有單位/);
  // 問題訊息不可以把姓名（個資）寫進去，只指出是第幾行。
  assert.ok(!result.problems[0].reason.includes('測試甲'));
});

test('只有單位沒有姓名也列為問題', () => {
  const result = parseRoster(['大溪分隊,']);
  assert.equal(result.entries.length, 0);
  assert.match(result.problems[0].reason, /沒有姓名/);
});

test('同單位同姓名只處理一次，並回報併掉幾筆', () => {
  const result = parseRoster(['大溪分隊,測試甲', '大溪分隊,測試甲', '中壢分隊,測試甲']);
  assert.equal(result.entries.length, 2); // 不同單位的同名者仍視為兩個人
  assert.equal(result.duplicateCount, 1);
});

test('行號對得回原始資料，出問題時指得出是第幾行', () => {
  const result = parseRoster(['大溪分隊,測試甲', '', '測試乙']);
  assert.equal(result.entries[0].lineNumber, 1);
  assert.equal(result.problems[0].lineNumber, 3);
});

test('去掉 BOM 與包住整段的引號', () => {
  assert.deepEqual(parseRosterLine('﻿"大溪分隊,測試甲"'), { unit: '大溪分隊', name: '測試甲' });
});

test('Excel：依標題找欄，不管單位與姓名誰在前面', () => {
  const matrix = [
    ['姓名', '單位', '備註'],
    ['測試甲', '大溪分隊', ''],
    ['測試乙', '中壢分隊', ''],
  ];
  const result = parseRosterMatrix(matrix);
  assert.deepEqual(result.entries.map((entry) => `${entry.unit}/${entry.name}`), [
    '大溪分隊/測試甲',
    '中壢分隊/測試乙',
  ]);
  // 行號要對回 Excel 的實際列（標題在第 1 列，第一筆資料在第 2 列）。
  assert.equal(result.entries[0].lineNumber, 2);
});

test('Excel：沒有標題列時用「第一欄單位、第二欄姓名」', () => {
  const result = parseRosterMatrix([
    ['大溪分隊', '測試甲'],
    ['中壢分隊', '測試乙'],
  ]);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].unit, '大溪分隊');
});

test('Excel：報表上方的說明列不會被當成資料', () => {
  const result = parseRosterMatrix([
    ['人員權限開通名冊'],
    [],
    ['單位', '姓名'],
    ['大溪分隊', '測試甲'],
  ]);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['測試甲']);
});

test('貼上時，標題列說「姓名在前」就照著解析', () => {
  // 使用者的 Excel 是 A 欄姓名、B 欄單位；連標題一起貼上就問得出來。
  const result = parseRoster(['姓名	單位', '測試甲	大溪分隊', '測試乙	中壢分隊']);
  assert.deepEqual(
    result.entries.map((entry) => `${entry.unit}/${entry.name}`),
    ['大溪分隊/測試甲', '中壢分隊/測試乙'],
  );
});

test('標題列說「單位在前」時維持原本的解析', () => {
  const result = parseRoster(['單位,姓名', '大溪分隊,測試甲']);
  assert.deepEqual(result.entries.map((entry) => `${entry.unit}/${entry.name}`), ['大溪分隊/測試甲']);
});

test('沒有標題列時仍照預設「單位在前」', () => {
  const result = parseRoster(['大溪分隊,測試甲']);
  assert.equal(result.entries[0].unit, '大溪分隊');
});

test('標題寫成「姓名／部門」也認得出欄序', () => {
  const result = parseRoster(['姓名,部門', '測試甲,大溪分隊']);
  assert.equal(result.entries[0].unit, '大溪分隊');
  assert.equal(result.entries[0].name, '測試甲');
});

test('公文清冊的示範列（(範例)）不會被當成真的人', () => {
  const result = parseRosterMatrix([
    ['大量傷病患系統 權限開通清冊', '', '', ''],
    ['單位', '姓名', '開放原因', ''],
    ['大溪分隊', '王小明', '幹部/TP', '(範例)'],
    ['大溪分隊', '測試甲', '幹部', ''],
  ]);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['測試甲']);
});

test('貼上時連示範列一起貼進來也會被跳過', () => {
  const result = parseRoster(['單位,姓名', '大溪分隊,王小明,幹部/TP,(範例)', '大溪分隊,測試甲']);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['測試甲']);
});

test('跨工作表共用去重集合：同一個人只算一次', () => {
  const seen = new Set();
  const 第一張 = parseRosterMatrix([['單位', '姓名'], ['大溪分隊', '測試甲']], { seen, sheetName: '大溪' });
  const 第二張 = parseRosterMatrix([['單位', '姓名'], ['大溪分隊', '測試甲']], { seen, sheetName: '中壢' });
  assert.equal(第一張.entries.length, 1);
  assert.equal(第二張.entries.length, 0);
  assert.equal(第二張.duplicateCount, 1);
});

test('問題列指得出是哪一張工作表的第幾列', () => {
  const result = parseRosterMatrix([['單位', '姓名'], ['大溪分隊', '']], { sheetName: '大溪' });
  assert.equal(result.problems.length, 1);
  assert.equal(describeRosterLocation(result.problems[0]), '工作表「大溪」第 2 列');
});

test('沒有工作表名稱時只講第幾列', () => {
  assert.equal(describeRosterLocation({ lineNumber: 7 }), '第 7 列');
});

test('示範列的單位寫成「OO分隊」也認得（那一版清冊沒有「(範例)」欄）', () => {
  const result = parseRosterMatrix([
    ['大量傷病患系統 權限開通清冊', '', ''],
    ['單位', '姓名', '開放原因'],
    ['OO分隊', '王小明', '幹部/TP'],
    ['大溪分隊', '測試甲', '分隊長'],
  ]);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['測試甲']);
});

test('全形○○分隊、XX分隊一樣算佔位字', () => {
  for (const 佔位 of ['○○分隊', '〇〇分隊', 'XX分隊', '＊＊分隊']) {
    const result = parseRosterMatrix([['單位', '姓名'], [佔位, '王小明'], ['大溪分隊', '測試甲']]);
    assert.deepEqual(result.entries.map((entry) => entry.name), ['測試甲'], 佔位);
  }
});

test('真的單位不會被誤判成佔位字', () => {
  const result = parseRosterMatrix([
    ['單位', '姓名'],
    ['大溪分隊', '測試甲'],
    ['第一搜救救助分隊', '測試乙'],
    ['觀音分隊', '測試丙'],
  ]);
  assert.equal(result.entries.length, 3);
});

test('拖一個檔進視窗：認得出是檔案', () => {
  assert.deepEqual(detectDroppedFiles(['D:/名單/一大.xlsx']), ['D:/名單/一大.xlsx']);
});

test('一次拖好幾個檔：全部都要認得（2026-08-30 只認一個而爆掉）', () => {
  const 四份 = ['D:/名單/一大.xlsx', 'D:/名單/二大.xlsx', 'D:/名單/三大.csv', 'D:/名單/四大.xls'];
  assert.deepEqual(detectDroppedFiles(四份), 四份);
});

test('混進一行真的名單就整批當成貼上的名單，不當檔案', () => {
  assert.deepEqual(detectDroppedFiles(['D:/名單/一大.xlsx', '大溪分隊,測試甲']), []);
});

test('什麼都沒貼時不算拖檔案', () => {
  assert.deepEqual(detectDroppedFiles([]), []);
  assert.deepEqual(detectDroppedFiles(['', '  ']), []);
});

test('一次讀好幾個檔時，問題列指得出是哪一份的哪一列', () => {
  const problem = { sourceName: '三大.xlsx', sheetName: '工作表1', lineNumber: 7 };
  assert.equal(describeRosterLocation(problem), '三大.xlsx 工作表「工作表1」第 7 列');
});
