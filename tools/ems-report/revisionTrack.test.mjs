/**
 * 結案後比對追蹤清單的測試（純函式為主；檔案讀寫用暫存資料夾）。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRecentRange } from './dateRange.mjs';
import {
  addTrackedEntry,
  shouldBackupRequest,
  buildBackupRemark,
  buildRevisionQueryRange,
  countDueToday,
  createDailyTrigger,
  createEntry,
  hasRemark,
  isClosedStatus,
  loadTracker,
  nextBackupVersion,
  parseBackupVersion,
  pickSheetButton,
  pickStaleComparisons,
  planRevisionWork,
  folderedRevisionPath,
  revisionCaseFolder,
  revisionFileNames,
  temsisCaseDate,
  toCloudRevision,
  updateTrackedEntry,
  withEntry,
} from './revisionTrack.mjs';

const PREFIX = '救護紀錄表內容-v';
const CONFIG = { maxWaitDays: 60, maxFailures: 5 };
const TEMSIS = '2026090710100307554102';

/** 建一筆測試用的追蹤資料。 */
function makeEntry(overrides = {}, now = new Date('2026-11-03T02:00:00Z')) {
  return {
    ...createEntry({ temsis: TEMSIS, version: 1, remark: `${PREFIX}1`, backupFile: 'x.pdf' }, now),
    ...overrides,
  };
}

test('檔案說明讀得出版號，空白與大小寫不影響', () => {
  assert.equal(parseBackupVersion('救護紀錄表內容-v2', PREFIX), 2);
  assert.equal(parseBackupVersion(' 救護紀錄表內容 - V12 ', PREFIX), 12);
  assert.equal(parseBackupVersion('ZOLL介接心電圖', PREFIX), null);
});

test('下一版：系統清單與本機清單取最大的加一；都沒有就是 v1', () => {
  assert.equal(nextBackupVersion([], PREFIX), 1);
  assert.equal(nextBackupVersion(['ZOLL介接心電圖', '救護紀錄表內容-v1'], PREFIX), 2);
  // 本機記過 v3（上次傳了但系統清單還沒出現），不可以撞號。
  assert.equal(nextBackupVersion(['救護紀錄表內容-v1'], PREFIX, [3]), 4);
  assert.equal(buildBackupRemark(2, PREFIX), '救護紀錄表內容-v2');
});

test('清單裡有沒有這一版（重試時避免傳兩份）', () => {
  assert.equal(hasRemark(['救護紀錄表內容 - v1'], '救護紀錄表內容-v1'), true);
  assert.equal(hasRemark(['救護紀錄表內容-v10'], '救護紀錄表內容-v1'), false);
});

test('檔名：上傳用純英數，本機用中文寫清楚，放進「案件年月/TEMSIS」資料夾', () => {
  const names = revisionFileNames(TEMSIS, 2);
  assert.equal(names.upload, `${TEMSIS}_v2.pdf`);
  assert.equal(names.backup, `2026-09/${TEMSIS}/${TEMSIS}-v2-解鎖前.pdf`);
  assert.equal(names.closed, `2026-09/${TEMSIS}/${TEMSIS}-v2-結案後.pdf`);
  assert.equal(names.report, `2026-09/${TEMSIS}/${TEMSIS}-v2-差異.txt`);
});

test('資料夾依案件日期分月（跨月再解鎖也在同一個資料夾）；看不出日期放「案件日期不明」', () => {
  assert.equal(revisionCaseFolder(TEMSIS), `2026-09/${TEMSIS}`);
  assert.equal(revisionCaseFolder('ABC-123'), '案件日期不明/ABC123');
});

test('舊版平放的檔案：算出搬進資料夾後的路徑；已在資料夾裡、空值就不搬', () => {
  assert.equal(folderedRevisionPath(`${TEMSIS}-v1-解鎖前.pdf`, TEMSIS), `2026-09/${TEMSIS}/${TEMSIS}-v1-解鎖前.pdf`);
  assert.equal(folderedRevisionPath(`2026-09/${TEMSIS}/${TEMSIS}-v1-解鎖前.pdf`, TEMSIS), null);
  assert.equal(folderedRevisionPath(null, TEMSIS), null);
});

test('救護狀態：已結案才算，未結案不會被誤認', () => {
  assert.equal(isClosedStatus('已結案', '已結案'), true);
  assert.equal(isClosedStatus(' 已結案(測) ', '已結案'), true);
  assert.equal(isClosedStatus('未結案', '已結案'), false);
  assert.equal(isClosedStatus('', '已結案'), false);
});

test('查詢期間：從 TEMSIS 的案件日期前一天到今天；看不出日期就退回近兩個月', () => {
  assert.equal(temsisCaseDate(TEMSIS), '2026-09-07');
  assert.equal(temsisCaseDate('20261340xxxx'), null);
  const now = new Date(2026, 10, 3, 9, 0);
  const range = buildRevisionQueryRange(TEMSIS, now, (date) => getRecentRange(2, date));
  assert.equal(range.start, '2026-09-06');
  assert.equal(range.end, '2026-11-03');
  const fallback = buildRevisionQueryRange('ABC', now, (date) => getRecentRange(2, date));
  assert.equal(fallback.end, '2026-11-03');
});

test('同一件又被解鎖（有下一版）時，上一版標成「被取代」，改拿兩份備份直接比', () => {
  const first = makeEntry({ requestId: 'r1' });
  const second = makeEntry({ version: 2, remark: `${PREFIX}2`, backupFile: 'y.pdf' });
  const tracker = withEntry(withEntry({ formatVersion: 1, entries: [] }, first), second);
  assert.equal(tracker.entries[0].state, 'superseded');
  assert.equal(tracker.entries[0].cloudSynced, false, '有工單的要把新狀態寫回雲端');
  const work = planRevisionWork(tracker, new Date('2026-11-04T02:00:00Z'), CONFIG);
  assert.equal(work.toCompareOffline.length, 1);
  assert.equal(work.toCompareOffline[0].next.version, 2);
  assert.deepEqual(work.toCheck.map((entry) => entry.version), [2]);
});

test('等太久的不再追；失敗太多次的先擱著', () => {
  const old = makeEntry({}, new Date('2026-08-01T00:00:00Z'));
  const failing = makeEntry({ version: 2, failCount: 5 });
  const fine = makeEntry({ version: 3 });
  const work = planRevisionWork({ formatVersion: 1, entries: [old, failing, fine] }, new Date('2026-11-03T03:00:00Z'), CONFIG);
  assert.deepEqual(work.toExpire.map((entry) => entry.version), [1]);
  assert.deepEqual(work.toCheck.map((entry) => entry.version), [3]);
});

test('今天查過的不算到期（一次性工具不必為它登入）', () => {
  const now = new Date(2026, 10, 3, 15, 0);
  const checkedToday = makeEntry({ lastCheckedAt: new Date(2026, 10, 3, 9, 0).toISOString() }, now);
  const checkedYesterday = makeEntry({ version: 2, lastCheckedAt: new Date(2026, 10, 2, 9, 0).toISOString() }, now);
  assert.equal(countDueToday({ formatVersion: 1, entries: [checkedToday, checkedYesterday] }, now, CONFIG), 1);
});

test('雲端版只有狀態與摘要，沒有本機檔名', () => {
  const cloud = toCloudRevision(makeEntry({ cloudItems: ['更正「姓名」'] }));
  assert.deepEqual(Object.keys(cloud).sort(), [
    'backedUpAt', 'changeCount', 'comparedAt', 'items', 'lastCheckedAt', 'lastStatus', 'remark', 'state', 'version',
  ]);
  assert.equal(JSON.stringify(cloud).includes('.pdf'), false);
});

test('挑「(桃)」那顆紀錄表按鈕；沒有就用第一顆', () => {
  const row = [{ index: 4, text: '救護紀錄PDF' }, { index: 5, text: '救護紀錄PDF(桃)' }];
  assert.equal(pickSheetButton(row, '桃').index, 5);
  assert.equal(pickSheetButton([{ index: 1, text: '救護紀錄PDF' }], '桃').index, 1);
  assert.equal(pickSheetButton([], '桃'), null);
});

test('每日觸發器：做完之後同一天不再到期，換一天又到期', () => {
  let now = new Date(2026, 10, 3, 9, 0);
  const trigger = createDailyTrigger(() => now);
  assert.equal(trigger.isDue(), true);
  trigger.markDone();
  assert.equal(trigger.isDue(), false);
  now = new Date(2026, 10, 4, 0, 1);
  assert.equal(trigger.isDue(), true);
});

test('追蹤清單：不存在時是空的；新增、更新後讀得回來；壞掉時不可以當成空的', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-track-'));
  const filePath = path.join(folder, '追蹤清單.json');
  try {
    assert.deepEqual((await loadTracker(filePath)).entries, []);
    await addTrackedEntry(filePath, makeEntry());
    const updated = await updateTrackedEntry(filePath, { temsis: TEMSIS, version: 1 }, { state: 'compared' });
    assert.equal(updated.state, 'compared');
    assert.equal((await loadTracker(filePath)).entries[0].state, 'compared');
    await fs.writeFile(filePath, '{ 壞掉', 'utf8');
    await assert.rejects(() => loadTracker(filePath), /格式壞掉/);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('上線時間（11/3 13:40）以前送出的工單不備份；之後（含）的才備份；時間讀不到的照樣備份', () => {
  const cutoff = '2026-11-03T13:40:00+08:00';
  assert.equal(shouldBackupRequest('2026-11-03T05:39:59.000Z', cutoff), false, '台灣 13:39:59');
  assert.equal(shouldBackupRequest('2026-11-03T05:40:00.000Z', cutoff), true, '台灣 13:40 整');
  assert.equal(shouldBackupRequest('2026-11-03T01:00:00.000Z', cutoff), false, '同一天早上也不追');
  assert.equal(shouldBackupRequest('', cutoff), true);
  assert.equal(shouldBackupRequest('亂寫', cutoff), true);
});

test('不設停止期限（null）時，等再久、失敗再多次都照樣追', () => {
  const old = makeEntry({ failCount: 99 }, new Date('2026-01-01T00:00:00Z'));
  const work = planRevisionWork({ formatVersion: 1, entries: [old] }, new Date('2026-11-03T03:00:00Z'),
    { maxWaitDays: null, maxFailures: null });
  assert.equal(work.toExpire.length, 0);
  assert.equal(work.toCheck.length, 1);
});

test('比對規則升版：只挑兩份檔都在、規則版本較舊的已比對案件', () => {
  const base = { backupFile: 'a.pdf', closedFile: 'b.pdf', state: 'compared' };
  const tracker = {
    formatVersion: 1,
    entries: [
      { ...base, temsis: '1', version: 1 },
      { ...base, temsis: '2', version: 1, diffRuleVersion: 2 },
      { ...base, temsis: '3', version: 1, closedFile: null },
      { ...base, temsis: '4', version: 1, state: 'waiting' },
      { ...base, temsis: '5', version: 1, refreshFailedVersion: 2 },
    ],
  };
  assert.deepEqual(pickStaleComparisons(tracker, 2).map((entry) => entry.temsis), ['1']);
  // 規則再升版時，之前失敗過的會再試一次
  assert.deepEqual(pickStaleComparisons(tracker, 3).map((entry) => entry.temsis), ['1', '2', '5']);
  assert.deepEqual(pickStaleComparisons(tracker, 1), []);
});
