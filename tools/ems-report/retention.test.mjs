/**
 * 舊月份產出清理的測試（純函式，不碰檔案）。
 *
 * 這支會**刪使用者的檔案**，所以邊界要釘死：
 *   - 認不出月份的檔案一個都不能碰
 *   - 保留哪幾個月依**檔名裡最新的月份**往回算，不是依今天
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectExpiredFiles } from './retention.mjs';

const FILES = [
  '心電圖到院前傳輸率-2026-07.xlsx',
  '心電圖到院前傳輸率-2026-06.xlsx',
  '心電圖到院前傳輸率-2026-05.xlsx',
  '心電圖到院前傳輸率-2026-04.xlsx',
  '到院前預警比率-2026-07.xlsx',
  '到院前預警比率-2026-03.xlsx',
  '心電圖執行報告-2026-07.md',
  '心電圖執行報告-2026-04.md',
];

test('只留最近三個月，更舊的都刪', () => {
  const { expired, keptMonths } = selectExpiredFiles(FILES, 3);
  assert.deepEqual(keptMonths, ['2026-07', '2026-06', '2026-05']);
  assert.deepEqual(expired.sort(), [
    '到院前預警比率-2026-03.xlsx',
    '心電圖到院前傳輸率-2026-04.xlsx',
    '心電圖執行報告-2026-04.md',
  ].sort());
});

test('保留範圍依檔名裡最新的月份算，不是依今天', () => {
  // 補跑舊月份時，不可以因為「今天是 8 月」就把 2026-07 掃掉。
  const { keptMonths, expired } = selectExpiredFiles(
    ['報表-2025-11.xlsx', '報表-2025-12.xlsx', '報表-2026-01.xlsx', '報表-2025-10.xlsx'],
    3,
  );
  assert.deepEqual(keptMonths, ['2026-01', '2025-12', '2025-11']);
  assert.deepEqual(expired, ['報表-2025-10.xlsx']);
});

test('認不出月份的檔案一個都不可以刪', () => {
  const { expired } = selectExpiredFiles([
    '報表-2026-01.xlsx',
    '報表-2020-01.xlsx',
    '使用者自己的筆記.xlsx',
    'README.md',
    '心電圖-有處置未勾選清冊.xlsx',
    '2026-01-備份.xlsx',
  ], 1);
  assert.deepEqual(expired, ['報表-2020-01.xlsx']);
});

test('查核進度檔（.json）也跟著同一套保留期限', () => {
  const { expired } = selectExpiredFiles([
    '心電圖查核進度-2026-07.json',
    '心電圖查核進度-2026-01.json',
  ], 1);
  assert.deepEqual(expired, ['心電圖查核進度-2026-01.json']);
});

test('月份數還不到保留上限時，一個都不刪', () => {
  const { expired } = selectExpiredFiles(['報表-2026-07.xlsx', '報表-2026-06.xlsx'], 3);
  assert.deepEqual(expired, []);
});

test('同一個月份的多個檔案要一起留或一起刪', () => {
  const { expired } = selectExpiredFiles([
    'A-2026-07.xlsx', 'B-2026-07.md',
    'A-2026-01.xlsx', 'B-2026-01.md', 'C-2026-01.csv',
  ], 1);
  assert.deepEqual(expired.sort(), ['A-2026-01.xlsx', 'B-2026-01.md', 'C-2026-01.csv']);
});
