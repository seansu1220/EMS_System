/**
 * 「邊跑邊落檔」的測試。
 *
 * 為什麼要有：`writeLogFile` 是**程式結束時**才寫的，對跑一整天的常駐監看等於沒有紀錄。
 * 2026-08-08 實際踩到——監看還活著（所以還沒落檔），中途掉過線，
 * 卻完全查不出是什麼時候、為什麼掉的。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log, enableLiveLog, disableLiveLog } from './logger.mjs';

/** 造一個暫存檔路徑，測完刪掉。 */
async function withTempLog(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-log-'));
  const file = path.join(dir, 'watch.log');
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await run(file);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    disableLiveLog();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 等落檔的佇列排空（追加是非同步的）。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('啟用之後，每一行都要立刻落檔（不是等結束才寫）', async () => {
  await withTempLog(async (file) => {
    await enableLiveLog(file);
    log.info('第一行');
    log.warn('第二行');
    await settle();
    const content = await fs.readFile(file, 'utf8');
    assert.match(content, /第一行/);
    assert.match(content, /第二行/);
  });
});

test('每一行都帶時間戳，事後才查得出「幾點發生的」', async () => {
  await withTempLog(async (file) => {
    await enableLiveLog(file);
    log.info('有時間的一行');
    await settle();
    const content = await fs.readFile(file, 'utf8');
    assert.match(content, /\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s+有時間的一行/);
  });
});

test('再次啟用是**追加**不是覆寫：跨多次執行的歷史要留得住', async () => {
  await withTempLog(async (file) => {
    await enableLiveLog(file);
    log.info('前一次執行');
    await settle();
    disableLiveLog();

    await enableLiveLog(file);
    log.info('這一次執行');
    await settle();

    const content = await fs.readFile(file, 'utf8');
    assert.match(content, /前一次執行/, '舊的紀錄不可以被蓋掉');
    assert.match(content, /這一次執行/);
    assert.equal((content.match(/開始執行/g) ?? []).length, 2, '每次執行都要有分隔標記');
  });
});

test('沒啟用時不會亂寫檔案（其他指令維持原本行為）', async () => {
  await withTempLog(async (file) => {
    disableLiveLog();
    log.info('這行不該落檔');
    await settle();
    await assert.rejects(fs.readFile(file, 'utf8'), '不該產生檔案');
  });
});

test('落檔失敗不可以影響主流程', async () => {
  await withTempLog(async (file) => {
    await enableLiveLog(file);
    // 把檔案換成資料夾，之後的追加一定會失敗。
    await fs.rm(file, { force: true });
    await fs.mkdir(file);
    // 這裡只要不拋錯就算通過：紀錄寫不進去，解鎖流程照樣要能跑。
    log.info('寫不進去的一行');
    await settle();
  });
});
