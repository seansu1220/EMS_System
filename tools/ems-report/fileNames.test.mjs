/**
 * 檔名規則的測試。
 *
 * 這裡釘住的兩件事，錯了都不會當場報錯、但後果很難查：
 *   1. 年月要在**最前面**（使用者 2026-09-05 要求，這樣資料夾才照時間排）
 *   2. **使用者自己的檔案不可以被當成產出**——月份在前正好是人也會用的取名方式，
 *      認錯了就會被保留期限清掉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTHLY_OUTPUT_NAMES,
  legacyMonthlyFileName,
  monthlyFileName,
  monthOfOutputFile,
} from './fileNames.mjs';

const JULY = { label: '2026-07' };

test('年月排在檔名最前面', () => {
  assert.equal(
    monthlyFileName(JULY, '心電圖到院前傳輸率', 'xlsx'),
    '2026-07-心電圖到院前傳輸率.xlsx',
  );
  assert.equal(monthlyFileName(JULY, '心電圖執行報告', 'md'), '2026-07-心電圖執行報告.md');
});

test('同一個月的檔案排在一起（照名稱排序就是照時間）', () => {
  const files = [
    monthlyFileName({ label: '2026-08' }, '心電圖執行報告', 'md'),
    monthlyFileName(JULY, '到院前預警比率', 'xlsx'),
    monthlyFileName({ label: '2026-08' }, '到院前預警比率', 'xlsx'),
    monthlyFileName(JULY, '心電圖執行報告', 'md'),
  ];
  assert.deepEqual(files.slice().sort(), [
    '2026-07-到院前預警比率.xlsx',
    '2026-07-心電圖執行報告.md',
    '2026-08-到院前預警比率.xlsx',
    '2026-08-心電圖執行報告.md',
  ]);
});

test('每一個產出檔名都認得出是哪個月', () => {
  for (const name of MONTHLY_OUTPUT_NAMES) {
    assert.equal(
      monthOfOutputFile(monthlyFileName(JULY, name, 'xlsx')),
      '2026-07',
      `${name} 認不出月份，保留期限就清不掉它`,
    );
  }
});

test('舊檔名（年月在後）照樣認得，否則先前產的檔案永遠清不掉', () => {
  assert.equal(monthOfOutputFile('心電圖到院前傳輸率-2026-07.xlsx'), '2026-07');
  assert.equal(monthOfOutputFile(legacyMonthlyFileName(JULY, '心電圖執行報告', 'md')), '2026-07');
});

test('使用者自己取的「月份在前」檔名不算產出檔', () => {
  assert.equal(monthOfOutputFile('2026-07-分隊回覆.xlsx'), null);
  assert.equal(monthOfOutputFile('2026-07-心電圖到院前傳輸率-修正版.xlsx'), null);
});

test('認不出來的一律回傳 null', () => {
  assert.equal(monthOfOutputFile('備忘.txt'), null);
  assert.equal(monthOfOutputFile('2026-07-心電圖執行報告.txt'), null);
  assert.equal(monthOfOutputFile('心電圖到院前傳輸率.xlsx'), null);
});
