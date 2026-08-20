/**
 * 名單解析的單元測試。
 *
 * ⚠ 這裡的姓名全是為了測試而編的，不是真實人員。
 *
 * 執行：npm run tool:mci:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster, parseRosterLine, parseRosterMatrix } from './roster.mjs';

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
