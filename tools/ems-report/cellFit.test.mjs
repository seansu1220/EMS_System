/**
 * 儲存格行數估算的測試。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateLineCount, rowHeightForLines, textWidthPx, usableCellWidthPx } from './cellFit.mjs';

const PARAMS = {
  pxPerWidthUnit: 7,
  columnPaddingPx: 5,
  cellInnerMarginPx: 6,
  safetyRatio: 0.9,
  lineHeightRatio: 1.42,
  rowPaddingPt: 4,
};

test('中文字算全形、英數算半形', () => {
  // 12pt＝16px：中文 16px、數字 8px。
  assert.equal(textWidthPx('桃園', 12), 32);
  assert.equal(textWidthPx('12', 12), 16);
  assert.equal(textWidthPx('（', 12), 16, '全形括號算全形');
  assert.equal(textWidthPx('ｱ', 12), 8, '半形片假名算半形');
});

test('可用寬度扣掉內距並打折', () => {
  // 10 × 7 + 5 − 6 ＝ 69，再 × 0.9
  assert.equal(usableCellWidthPx(10, PARAMS), 69 * 0.9);
});

test('短字一行、長字照寬度換行、文字裡的換行各自起一行', () => {
  assert.equal(estimateLineCount('', 26.22, 14, PARAMS), 1);
  assert.equal(estimateLineCount('桃園市中壢區', 26.22, 14, PARAMS), 1);
  // 26.22 欄寬、14 號字一行約放 8 個中文字，30 字一定超過三行。
  assert.ok(estimateLineCount('桃'.repeat(30), 26.22, 14, PARAMS) >= 4);
  assert.equal(estimateLineCount('甲\n乙', 26.22, 14, PARAMS), 2);
});

test('列高不低於範本值，行數多時跟著加高', () => {
  assert.equal(rowHeightForLines(1, 14, PARAMS, 33.6), 33.6, '一行時維持範本列高');
  const twoLines = rowHeightForLines(2, 14, PARAMS, 33.6);
  assert.ok(twoLines > 33.6, '14 號字兩行就超過範本列高——這正是被切字的原因');
  assert.ok(rowHeightForLines(4, 14, PARAMS, 33.6) > twoLines);
});
