/**
 * 月報表包裝資料夾的測試。
 *
 * 釘住的是三件會出事的事：
 *   1. 可發給分隊的與不可外發的**不可以混在同一個資料夾**
 *   2. **人工判定清單不可以被複製**（使用者會填副本，而程式只讀正本）
 *   3. 用複製而不是搬移（原檔要留著，否則續跑要重跑一兩個小時）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleMonthlyOutputs, buildReadme, bundleFolderName, shouldBundle } from './bundle.mjs';
import { PATHS } from './config.mjs';

const MONTH = { start: '2026-09-01', end: '2026-09-30', label: '2026-09' };

/** 建一個暫時的 out/ 結構，跑完刪掉，不動使用者真正的產出。 */
async function withTemporaryOut(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-bundle-'));
  const original = { outDir: PATHS.outDir, reportDir: PATHS.reportDir, internalDir: PATHS.internalDir };
  PATHS.outDir = root;
  PATHS.reportDir = path.join(root, 'report');
  PATHS.internalDir = path.join(root, 'internal');
  await fs.mkdir(PATHS.reportDir, { recursive: true });
  await fs.mkdir(PATHS.internalDir, { recursive: true });
  context.after(async () => {
    Object.assign(PATHS, original);
    // 刪不掉就算了（Windows 上剛寫完的檔案偶爾還鎖著），清理失敗不代表測試失敗。
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  });
  return root;
}

const write = (directory, fileName) =>
  fs.writeFile(path.join(directory, fileName), 'x', 'utf8');

test('只收這個月的產出，別的月份與別人的檔案都不動', () => {
  assert.equal(shouldBundle('2026-09-心電圖到院前傳輸率.xlsx', '2026-09'), true);
  assert.equal(shouldBundle('2026-08-心電圖到院前傳輸率.xlsx', '2026-09'), false);
  // 認不出來的不是我們產的（使用者自己放的檔案），一律不碰。
  assert.equal(shouldBundle('2026-09-分隊回覆.xlsx', '2026-09'), false);
  assert.equal(shouldBundle('月度報表怎麼跑.md', '2026-09'), false);
});

test('人工判定清單與進度檔不收進來', () => {
  // ⚠ 人工判定清單要填正本。複製一份進來，使用者十之八九會填副本，
  //   而程式只讀 out/internal 的正本——填了卻沒生效，而且完全看不出來。
  assert.equal(shouldBundle('2026-09-心電圖-人工判定.xlsx', '2026-09'), false);
  assert.equal(shouldBundle('2026-09-心電圖查核進度.json', '2026-09'), false);
});

test('可發給分隊的與不可外發的分在兩個子資料夾，不混在一起', async (context) => {
  const root = await withTemporaryOut(context);
  await write(PATHS.reportDir, '2026-09-心電圖到院前傳輸率.xlsx');
  await write(PATHS.reportDir, '2026-09-到院前預警比率.xlsx');
  await write(PATHS.internalDir, '2026-09-心電圖逐案判定.xlsx');
  await write(PATHS.internalDir, '2026-09-心電圖執行報告.md');

  const result = await bundleMonthlyOutputs(MONTH);
  assert.ok(result, '應該要收到檔案');

  const folder = path.join(root, bundleFolderName(MONTH));
  const 可發 = await fs.readdir(path.join(folder, '可發給分隊'));
  const 不可發 = await fs.readdir(path.join(folder, '內部用-不要外發'));

  assert.deepEqual(可發.sort(), ['2026-09-到院前預警比率.xlsx', '2026-09-心電圖到院前傳輸率.xlsx']);
  assert.deepEqual(不可發.sort(), ['2026-09-心電圖執行報告.md', '2026-09-心電圖逐案判定.xlsx']);
  // 逐案判定表絕不可以出現在「可發給分隊」那一邊。
  assert.ok(!可發.some((name) => name.includes('逐案判定')));
});

test('是搬移不是複製——原處不可以留副本', async (context) => {
  // 2026-10-10 改：原本是複製，於是同一份檔案在 out/report、out/internal 與
  // 月報表資料夾各有一份，使用者的原話是「internal 裡面還是很亂」。
  // 收納的目的就是「東西只在一個地方」，留副本等於沒收。
  await withTemporaryOut(context);
  await write(PATHS.reportDir, '2026-09-心電圖到院前傳輸率.xlsx');
  await bundleMonthlyOutputs(MONTH);
  await assert.rejects(
    fs.access(path.join(PATHS.reportDir, '2026-09-心電圖到院前傳輸率.xlsx')),
    '原檔應該已經被搬走',
  );
});

test('重跑同一個月份：目的地已經有上一次的檔案也要能蓋過去', async (context) => {
  // Windows 上 rename 到已存在的檔案會失敗，所以實作是「先複製再刪原檔」。
  const root = await withTemporaryOut(context);
  await write(PATHS.reportDir, '2026-09-心電圖到院前傳輸率.xlsx');
  await bundleMonthlyOutputs(MONTH);
  await write(PATHS.reportDir, '2026-09-心電圖到院前傳輸率.xlsx');
  await assert.doesNotReject(bundleMonthlyOutputs(MONTH));
  const 可發 = await fs.readdir(path.join(root, bundleFolderName(MONTH), '可發給分隊'));
  assert.deepEqual(可發, ['2026-09-心電圖到院前傳輸率.xlsx']);
});

test('一個檔案都沒有時不生出空資料夾', async (context) => {
  const root = await withTemporaryOut(context);
  assert.equal(await bundleMonthlyOutputs(MONTH), null);
  const entries = await fs.readdir(root);
  assert.ok(!entries.includes(bundleFolderName(MONTH)), '不該留一個空資料夾讓人以為跑成功了');
});

test('只有一邊有檔案時，另一邊不生出空的子資料夾', async (context) => {
  const root = await withTemporaryOut(context);
  await write(PATHS.internalDir, '2026-09-心電圖執行報告.md');
  await bundleMonthlyOutputs(MONTH);
  const entries = await fs.readdir(path.join(root, bundleFolderName(MONTH)));
  assert.deepEqual(entries.sort(), ['內部用-不要外發', '請先看我.txt']);
});

test('說明檔先講哪些不能外發，再指路去填人工判定', async (context) => {
  const root = await withTemporaryOut(context);
  await write(PATHS.reportDir, '2026-09-心電圖到院前傳輸率.xlsx');
  await write(PATHS.internalDir, '2026-09-心電圖逐案判定.xlsx');
  await bundleMonthlyOutputs(MONTH);

  const readme = await fs.readFile(
    path.join(root, bundleFolderName(MONTH), '請先看我.txt'),
    'utf8',
  );
  assert.match(readme, /不要發給分隊/);
  assert.match(readme, /2026-09-心電圖逐案判定\.xlsx/, '要逐檔列出來，不能只說「有幾個檔案」');
  // 使用者實際踩到的就是「不知道要去開哪一個檔案」，所以要指名、而且講在顯眼的位置。
  assert.match(readme, /★ 要你動手的只有一個檔案/);
  assert.match(readme, /2026-09-心電圖-人工判定\.xlsx/);
  assert.match(readme, /不會在別的地方留副本/);
});

test('說明檔用 CRLF，記事本開起來才不會全部黏成一行', () => {
  const readme = buildReadme(MONTH, { report: ['a.xlsx'], internal: ['b.xlsx'] });
  assert.ok(readme.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(readme), '不可以有單獨的 LF');
});
