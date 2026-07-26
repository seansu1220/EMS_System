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

test('formatDateForSite 依樣板轉換日期', () => {
  assert.equal(formatDateForSite('2026-06-01', 'yyyy-MM-dd'), '2026-06-01');
  assert.equal(formatDateForSite('2026-06-01', 'yyyy/MM/dd'), '2026/06/01');
  assert.equal(formatDateForSite('2026-06-01', 'ryyy/MM/dd'), '115/06/01', '民國年');
  assert.equal(formatDateForSite('2026-06-30', 'yy.MM.dd'), '26.06.30');
  assert.throws(() => formatDateForSite('2026-6-1', 'yyyy-MM-dd'), /YYYY-MM-DD/);
  assert.throws(() => formatDateForSite('2026-06-01', ''), /無效的日期格式樣板/);
});

test('formatDateForSite 處理含時間的樣板（系統實際使用的格式）', () => {
  // 未處理時間時會留下字面上的 HH:mm:ss，使查詢條件失效，故特別釘住。
  assert.equal(formatDateForSite('2026-06-01', 'yyyy-MM-dd HH:mm:ss'), '2026-06-01 00:00:00');
  assert.equal(
    formatDateForSite('2026-06-30', 'yyyy-MM-dd HH:mm:ss', { endOfDay: true }),
    '2026-06-30 23:59:59',
    '迄日要涵蓋整天，否則會漏掉當天的案件',
  );
  assert.ok(!formatDateForSite('2026-06-01', 'yyyy-MM-dd HH:mm:ss').includes('H'), '不可殘留樣板字元');
  // MM（月）與 mm（分）大小寫不同，不可互相污染
  assert.equal(formatDateForSite('2026-11-05', 'MM/dd HH:mm'), '11/05 00:00');
});
