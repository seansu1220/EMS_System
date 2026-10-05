/**
 * 查詢期間計算的單元測試（純函式，不需網路與瀏覽器）。
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMonthRange,
  getPreviousMonthRange,
  resolveMonthRange,
  formatDateForSite,
  parseUserDate,
  buildCustomRange,
  countRangeDays,
  padRange,
} from './dateRange.mjs';

test('parseUserDate 接受常見的幾種寫法', () => {
  assert.equal(parseUserDate('2026-09-01'), '2026-09-01');
  assert.equal(parseUserDate(' 2026/9/1 '), '2026-09-01');
  assert.equal(parseUserDate('2026.9.1'), '2026-09-01');
  assert.equal(parseUserDate('20260901'), '2026-09-01');
  assert.equal(parseUserDate('115/09/01'), '2026-09-01', '民國年要加 1911');
  assert.equal(parseUserDate('1150901'), '2026-09-01', '民國 7 碼連寫');
  assert.throws(() => parseUserDate('2026-02-30'), /不存在/);
  assert.throws(() => parseUserDate('2026-13-01'), /不存在/);
  assert.throws(() => parseUserDate('九月一日'), /看不懂/);
  assert.throws(() => parseUserDate(''), /看不懂/);
});

test('buildCustomRange 組出期間，label 只用日期（會進檔名）', () => {
  assert.deepEqual(buildCustomRange('2026/9/1', '115/09/30'), {
    label: '2026-09-01至2026-09-30',
    start: '2026-09-01',
    end: '2026-09-30',
  });
  assert.equal(buildCustomRange('2026-09-05', '2026-09-05').start, '2026-09-05', '同一天可以');
  assert.throws(() => buildCustomRange('2026-09-30', '2026-09-01'), /晚於/);
});

test('countRangeDays 含頭尾、跨月跨年都算對', () => {
  assert.equal(countRangeDays({ start: '2026-09-01', end: '2026-09-30' }), 30);
  assert.equal(countRangeDays({ start: '2026-09-05', end: '2026-09-05' }), 1);
  assert.equal(countRangeDays({ start: '2025-12-31', end: '2026-01-01' }), 2);
});

test('padRange 前後放寬，跨月跨年正確，且不改動輸入', () => {
  const original = { label: 'x', start: '2026-03-01', end: '2026-12-31' };
  assert.deepEqual(padRange(original, 1), { label: 'x', start: '2026-02-28', end: '2027-01-01' });
  assert.equal(original.start, '2026-03-01');
});

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
