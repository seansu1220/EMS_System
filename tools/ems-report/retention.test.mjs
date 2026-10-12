/**
 * 舊月份產出清理的測試（最後一項會在暫存資料夾裡實際建檔、刪檔）。
 *
 * 這支會**刪使用者的檔案**，所以邊界要釘死：
 *   - 認不出月份的檔案一個都不能碰
 *   - 保留哪幾個月依**檔名裡最新的月份**往回算，不是依今天
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneOldOutputs, selectExpiredFiles } from './retention.mjs';
import { PATHS } from './config.mjs';

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

test('新檔名（年月在前）一樣照月份清理', () => {
  const { expired, keptMonths } = selectExpiredFiles([
    '2026-07-心電圖到院前傳輸率.xlsx',
    '2026-06-心電圖到院前傳輸率.xlsx',
    '2026-03-心電圖執行報告.md',
  ], 2);
  assert.deepEqual(keptMonths, ['2026-07', '2026-06']);
  assert.deepEqual(expired, ['2026-03-心電圖執行報告.md']);
});

test('新舊檔名混在同一個資料夾時，月份要算在一起', () => {
  const { expired } = selectExpiredFiles([
    '2026-07-心電圖到院前傳輸率.xlsx',
    '心電圖執行報告-2026-07.md',
    '心電圖到院前傳輸率-2026-04.xlsx',
  ], 1);
  assert.deepEqual(expired, ['心電圖到院前傳輸率-2026-04.xlsx']);
});

test('使用者自己放的「月份在前」檔案不會被刪', () => {
  const { expired } = selectExpiredFiles([
    '2026-07-心電圖到院前傳輸率.xlsx',
    '2026-01-分隊回覆.xlsx',
  ], 1);
  assert.deepEqual(expired, []);
});

test('最近幾個月可以由別處的檔名決定（三處合起來算）', () => {
  // out/report/ 只剩 7、8 月的舊檔，但新月份都在月報表資料夾裡。
  const reportFiles = ['到院前預警比率-2026-07.xlsx', '到院前預警比率-2026-08.xlsx'];
  const reference = [...reportFiles, '2026-09-月報表.xlsx', '2026-10-月報表.xlsx', '2026-11-月報表.xlsx'];
  const { keptMonths, expired } = selectExpiredFiles(reportFiles, 3, reference);
  assert.deepEqual(keptMonths, ['2026-11', '2026-10', '2026-09']);
  assert.deepEqual(expired.sort(), reportFiles.sort());
});

test('out/report 不再有新檔進來時，舊檔照樣會隨月報表資料夾的月份被清掉', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-retention-'));
  const original = { outDir: PATHS.outDir, reportDir: PATHS.reportDir, internalDir: PATHS.internalDir };
  Object.assign(PATHS, {
    outDir: root,
    reportDir: path.join(root, 'report'),
    internalDir: path.join(root, 'internal'),
  });
  context.after(async () => {
    Object.assign(PATHS, original);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  await fs.mkdir(PATHS.reportDir, { recursive: true });
  await fs.mkdir(PATHS.internalDir, { recursive: true });
  for (const name of ['到院前預警比率-2026-07.xlsx', '到院前預警比率-2026-08.xlsx', '月度報表怎麼跑.md']) {
    await fs.writeFile(path.join(PATHS.reportDir, name), '');
  }
  await fs.writeFile(path.join(PATHS.internalDir, '心電圖逐案判定-2026-08.xlsx'), '');
  for (const month of ['2026-07', '2026-09', '2026-10', '2026-11']) {
    await fs.mkdir(path.join(root, `${month}-月報表`, '可發給分隊'), { recursive: true });
  }

  await pruneOldOutputs(3);

  assert.deepEqual(await fs.readdir(PATHS.reportDir), ['月度報表怎麼跑.md']);
  assert.deepEqual(await fs.readdir(PATHS.internalDir), []);
  const folders = (await fs.readdir(root)).filter((name) => name.endsWith('月報表')).sort();
  assert.deepEqual(folders, ['2026-09-月報表', '2026-10-月報表', '2026-11-月報表']);
});
