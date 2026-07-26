/**
 * 分隊彙總統計的單元測試（純函式，不需網路與瀏覽器）。
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSquadColumn,
  countBySquad,
  buildComparison,
  summarize,
  formatRatio,
} from './aggregate.mjs';
import { findHeaderRowIndex } from './workbook.mjs';

const CANDIDATES = ['分隊', '分隊名稱', '救護分隊', '單位'];

test('resolveSquadColumn 以欄名比對（資料不足以判斷內容時）', () => {
  assert.equal(resolveSquadColumn(['案件編號', '分隊', '送醫院所'], [], CANDIDATES).column, '分隊');
  assert.equal(resolveSquadColumn(['案件編號', '救護分隊'], [], CANDIDATES).column, '救護分隊');
  assert.equal(resolveSquadColumn(['案件編號', ' 分 隊 '], [], CANDIDATES).column, ' 分 隊 ', '忽略空白差異');
  assert.equal(resolveSquadColumn(['出勤分隊名稱'], [], CANDIDATES).column, '出勤分隊名稱', '退而求其次用包含比對');
  assert.throws(() => resolveSquadColumn(['案件編號', '姓名'], [], CANDIDATES), /找不到分隊欄位/);
});

test('resolveSquadColumn 以內容判斷，不被名稱含「分隊」的勾選欄騙走', () => {
  // 重現實際踩到的狀況：匯出檔有「分隊 自行受理」這個勾選欄（值為 V），
  // 真正的分隊在另一個欄名完全不含「分隊」的欄位。
  const headers = ['案件編號', '分隊 自行受理', '受理單位'];
  const rows = [
    { '案件編號': 'A1', '分隊 自行受理': 'V', '受理單位': '桃園分隊' },
    { '案件編號': 'A2', '分隊 自行受理': '', '受理單位': '大林分隊' },
    { '案件編號': 'A3', '分隊 自行受理': 'V', '受理單位': '中路分隊' },
    { '案件編號': 'A4', '分隊 自行受理': '', '受理單位': '第一救災救護大隊' },
  ];
  const resolved = resolveSquadColumn(headers, rows, CANDIDATES);
  assert.equal(resolved.column, '受理單位');
  assert.match(resolved.reason, /內容/);
});

test('resolveSquadColumn 內容判斷勝過欄名完全相符', () => {
  const headers = ['分隊', '出勤單位'];
  const rows = [
    { '分隊': 'V', '出勤單位': '桃園分隊' },
    { '分隊': 'V', '出勤單位': '大林分隊' },
  ];
  assert.equal(resolveSquadColumn(headers, rows, CANDIDATES).column, '出勤單位');
});

test('countBySquad 依分隊計數', () => {
  const rows = [
    { 分隊: '桃園分隊' },
    { 分隊: '桃園分隊' },
    { 分隊: '大林分隊' },
    { 分隊: '' },
    { 分隊: '  ' },
    {},
  ];
  const counts = countBySquad(rows, '分隊');
  assert.equal(counts.get('桃園分隊'), 2);
  assert.equal(counts.get('大林分隊'), 1);
  assert.equal(counts.size, 2, '空白分隊不列入');
});

test('buildComparison 合併兩份計數並排序', () => {
  // 用 A/B 命名避免測試相依於中文排序規則，只驗證「數量優先、同數量時順序固定」。
  const total = new Map([['桃園分隊', 100], ['B分隊', 50], ['A分隊', 50]]);
  const alert = new Map([['桃園分隊', 25], ['B分隊', 5]]);
  const stats = buildComparison(total, alert);

  assert.deepEqual(stats.map((item) => item.squad), ['桃園分隊', 'A分隊', 'B分隊'],
    '依總案件數由多到少，同數量再依分隊名稱');
  assert.equal(stats[0].ratio, 0.25);
  assert.equal(stats[1].alertCount, 0, '沒有預警案件的分隊補 0');
  assert.equal(stats[1].ratio, 0);
});

test('buildComparison 處理只出現在預警檔的分隊', () => {
  const stats = buildComparison(new Map(), new Map([['幽靈分隊', 3]]));
  assert.equal(stats[0].totalCount, 0);
  assert.equal(stats[0].ratio, null, '總案件數為 0 時比率為 null，不可除以零');
});

test('summarize 計算合計', () => {
  const stats = buildComparison(
    new Map([['甲分隊', 80], ['乙分隊', 20]]),
    new Map([['甲分隊', 8], ['乙分隊', 2]]),
  );
  const summary = summarize(stats);
  assert.equal(summary.totalCount, 100);
  assert.equal(summary.alertCount, 10);
  assert.equal(summary.ratio, 0.1);
  assert.equal(summarize([]).ratio, null);
});

test('formatRatio 顯示格式', () => {
  assert.equal(formatRatio(0.2537), '25.4%');
  assert.equal(formatRatio(0), '0.0%');
  assert.equal(formatRatio(null), '—');
});

test('findHeaderRowIndex 跳過匯出檔上方的說明列', () => {
  const matrix = [
    ['救護紀錄表查詢結果'],
    ['查詢期間：2026-06-01 ~ 2026-06-30'],
    [],
    ['案件編號', '分隊', '送醫院所'],
    ['A0001', '桃園分隊', '某醫院'],
  ];
  assert.equal(findHeaderRowIndex(matrix, CANDIDATES), 3);
  assert.equal(findHeaderRowIndex([['姓名', '年齡']], CANDIDATES), -1);
});
