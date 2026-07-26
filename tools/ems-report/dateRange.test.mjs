/**
 * 查詢期間計算的單元測試（純函式，不需網路與瀏覽器）。
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMonthRange, getPreviousMonthRange, resolveMonthRange, formatDateForSite } from './dateRange.mjs';

test('getMonthRange 取得整月區間', () => {
  assert.deepEqual(getMonthRange(2026, 2), { label: '2026-02', start: '2026-02-01', end: '2026-02-28' });
  assert.equal(getMonthRange(2024, 2).end, '2024-02-29', '閏年 2 月應為 29 日');
  assert.equal(getMonthRange(2026, 12).end, '2026-12-31');
  assert.throws(() => getMonthRange(2026, 13), RangeError);
});

test('getPreviousMonthRange 取得上個月', () => {
  assert.deepEqual(getPreviousMonthRange(new Date(2026, 6, 26)), {
    label: '2026-06',
    start: '2026-06-01',
    end: '2026-06-30',
  });
  assert.equal(getPreviousMonthRange(new Date(2026, 0, 5)).label, '2025-12', '1 月要跨年回到去年 12 月');
  assert.equal(getPreviousMonthRange(new Date(2024, 2, 15)).end, '2024-02-29');
});

test('resolveMonthRange 解析 --month 參數', () => {
  assert.equal(resolveMonthRange('2026-06').start, '2026-06-01');
  assert.equal(resolveMonthRange('2026-6').label, '2026-06');
  assert.equal(resolveMonthRange(undefined, new Date(2026, 6, 26)).label, '2026-06');
  assert.throws(() => resolveMonthRange('2026/06'), /格式/);
});

test('formatDateForSite 轉換系統日期格式', () => {
  assert.equal(formatDateForSite('2026-06-01', 'iso'), '2026-06-01');
  assert.equal(formatDateForSite('2026-06-01', 'slash'), '2026/06/01');
  assert.equal(formatDateForSite('2026-06-01', 'roc'), '115/06/01');
  assert.throws(() => formatDateForSite('2026-06-01', 'unknown'), /未知的日期格式/);
});
