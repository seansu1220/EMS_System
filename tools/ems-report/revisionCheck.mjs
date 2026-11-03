/**
 * 結案後比對（v1.54.0，使用者 2026-11-03 指定）。
 *
 * 每次開啟線上解鎖工具（以及監看跨日時）做兩件事：
 *   1. 追蹤清單裡每一件，以 TEMSIS 到「救護紀錄表查詢」看**救護狀態**變回「已結案」了沒
 *   2. 已結案的，點開「救護紀錄PDF(桃)」，跟解鎖前備份的那份比對，條列出哪裡不同
 *
 * 結果：
 *   - **本機**：結案後的 PDF ＋ 差異報告（含病患資料）放在 `out/internal/解鎖前後比對/`
 *   - **雲端**（線上工單才有）：工單的 `revision` 欄位寫「改了哪些欄位」，
 *     身分證、姓名這類只寫欄位名、不寫內容（`sheetDiff.toCloudItems`）
 *   - **終端機／紀錄檔**：只印雲端版的摘要與報告檔名，不印病患資料
 *
 * 這一支只讀不寫系統資料（不按任何會改動案件的按鈕），所以不分試跑／正式。
 * `checkRevisionsSafely` **絕不丟例外**：它是「順便做」的事，不能拖垮解鎖或監看。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyDateRange,
  applyTextCondition,
  content,
  findClickablesWithRetry,
  pickFirstValue,
  submitQuery,
} from './caseFlow.mjs';
import { PATHS, UNLOCK } from './config.mjs';
import { getRecentRange } from './dateRange.mjs';
import { log } from './logger.mjs';
import { gotoRecordQuery } from './navigation.mjs';
import { groupByRow, readRowFields } from './pageFinder.mjs';
import { extractPdfItems } from './pdfText.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import {
  buildRevisionQueryRange,
  isClosedStatus,
  loadTracker,
  pickSheetButton,
  planRevisionWork,
  revisionFileNames,
  toCloudRevision,
  updateTrackedEntry,
} from './revisionTrack.mjs';
import { TRACKER_FILE } from './sheetBackup.mjs';
import { describeChanges, formatLocalReport, toCloudItems } from './sheetDiff.mjs';
import { extractLabeledCode, isSameCode, maskCode } from './sheetFields.mjs';
import { saveRevision } from './unlockQueue.mjs';

/** 一件的鍵（追蹤清單以 TEMSIS＋版號認一筆）。 */
const keyOf = (entry) => ({ temsis: entry.temsis, version: entry.version });

/**
 * 讀本機的 PDF 並取出「文字＋座標」（比對依座標，見 `sheetDiff.mjs`）。
 * @returns {Promise<import('./pdfText.mjs').PdfTextItem[]>}
 */
async function readLocalSheetItems(fileName) {
  const filePath = path.join(PATHS.revisionDir, fileName);
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`讀不到本機的備份檔（${fileName}）：${error instanceof Error ? error.message : error}`);
  }
  return extractPdfItems(bytes, { maxPages: UNLOCK.revision.maxPdfPages });
}

/**
 * 比對兩份文字，寫本機報告，回傳要更新進追蹤清單的欄位。
 *
 * @param {import('./revisionTrack.mjs').RevisionEntry} entry
 * @param {{beforeItems: import('./pdfText.mjs').PdfTextItem[],
 *   afterItems: import('./pdfText.mjs').PdfTextItem[], closedFile: string}} sheets
 * @returns {Promise<Partial<import('./revisionTrack.mjs').RevisionEntry>>}
 */
async function compareAndReport(entry, sheets) {
  const config = UNLOCK.revision;
  const changes = describeChanges(sheets.beforeItems, sheets.afterItems, config);
  const comparedAt = new Date().toISOString();
  const names = revisionFileNames(entry.temsis, entry.version);
  const report = formatLocalReport(
    {
      temsis: entry.temsis,
      caseDate: entry.caseDate,
      vehicle: entry.vehicle,
      squad: entry.squad,
      remark: entry.remark,
      unlockedAt: entry.unlockedAt,
      comparedAt,
      backupFile: entry.backupFile,
      closedFile: sheets.closedFile,
    },
    changes,
    config,
  );
  try {
    await fs.mkdir(PATHS.revisionDir, { recursive: true });
    await fs.writeFile(path.join(PATHS.revisionDir, names.report), report, 'utf8');
  } catch (error) {
    throw new Error(`差異報告寫不進本機（${names.report}）：${error instanceof Error ? error.message : error}`);
  }
  const cloud = toCloudItems(changes, config);
  printComparison(entry, cloud, names.report);
  return {
    state: 'compared',
    comparedAt,
    closedFile: sheets.closedFile,
    reportFile: names.report,
    changeCount: cloud.changeCount,
    cloudItems: cloud.items,
    cloudSynced: !entry.requestId,
    failCount: 0,
    lastError: null,
  };
}

/** 終端機只印雲端版摘要（不含病患資料），完整內容看報告檔。 */
function printComparison(entry, cloud, reportFile) {
  const vehicle = entry.vehicle ?? entry.squad ?? '車輛讀不到';
  if (cloud.changeCount === 0) {
    log.ok(`比對完成：${entry.caseDate ?? '日期讀不到'}　${vehicle}　TEMSIS ${maskCode(entry.temsis)}　解鎖後沒有改動任何內容`);
  } else {
    log.ok(
      `比對完成：${entry.caseDate ?? '日期讀不到'}　${vehicle}　TEMSIS ${maskCode(entry.temsis)}`
        + `　共 ${cloud.changeCount} 處不同`,
    );
    for (const item of cloud.items) log.info(`　・${item}`);
  }
  log.info(`　完整內容（含病患資料，勿外傳）：out/internal/解鎖前後比對/${reportFile}`);
}

/**
 * 以 TEMSIS 查回那一列，讀救護狀態。
 * @returns {Promise<{status: string, row: import('./pageFinder.mjs').ClickableMatch[]}>}
 */
async function readRescueStatus(page, temsis) {
  const range = buildRevisionQueryRange(temsis, new Date(), (now) => getRecentRange(UNLOCK.lookbackMonths, now));
  await gotoRecordQuery(page);
  await applyDateRange(page, range);
  await applyTextCondition(page, UNLOCK.fieldLabels.temsis, temsis, 'TEMSIS');
  await submitQuery(page);
  const rows = groupByRow(await findClickablesWithRetry(page, UNLOCK.buttonTexts.openRecordSheet));
  if (rows.length === 0) throw new Error(`以 TEMSIS 查不到案件（查詢期間 ${range.start} ~ ${range.end}）`);
  const fields = await readRowFields(
    content(page),
    UNLOCK.buttonTexts.openRecordSheet,
    rows[0][0].index,
    UNLOCK.revision.statusColumns,
  ).catch(() => null);
  const status = pickFirstValue(fields, UNLOCK.revision.statusColumns);
  if (!status) {
    throw new Error(
      `查詢結果讀不到「${UNLOCK.revision.statusColumns[0]}」欄`
        + `（這一列的欄位：${fields?.headers?.join('｜') || '讀不到表格'}）`,
    );
  }
  return { status, row: rows[0] };
}

/**
 * 查一件：沒結案就記下狀態；結案了就抓結案後的 PDF 比對。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {import('./revisionTrack.mjs').RevisionEntry} entry
 * @returns {Promise<Partial<import('./revisionTrack.mjs').RevisionEntry>>} 要更新的欄位
 */
async function checkOne(session, entry) {
  const { context, page } = session;
  const { status, row } = await readRescueStatus(page, entry.temsis);
  const checked = { lastCheckedAt: new Date().toISOString(), lastStatus: status, failCount: 0, lastError: null };
  if (!isClosedStatus(status, UNLOCK.revision.closedStatus)) {
    log.info(`　TEMSIS ${maskCode(entry.temsis)}：案件未結案（救護狀態「${status}」），下次再看`);
    // 還沒結案也要寫回工單：網頁要顯示「案件未結案」與最後確認時間（使用者 2026-11-03 要求）。
    return { ...checked, cloudSynced: !entry.requestId };
  }

  log.info(`　TEMSIS ${maskCode(entry.temsis)}：已結案，開「救護紀錄PDF(桃)」跟解鎖前的 ${entry.remark} 比對`);
  const button = pickSheetButton(row, UNLOCK.backup.sheetButtonMarker);
  const sheet = await openRecordSheet(context, content(page), UNLOCK.buttonTexts.openRecordSheet, button.index, {
    keepBytes: true,
    maxPages: UNLOCK.revision.maxPdfPages,
  });
  if (!sheet.bytes) throw new Error('結案後的紀錄表不是 PDF 檔，無法存檔比對');
  // 防呆：紀錄表上的 TEMSIS 要跟追的這件一樣，不一樣代表查詢條件沒生效、開到別件。
  const sheetTemsis = extractLabeledCode(sheet.text, UNLOCK.sheetLabels.temsis)?.value ?? null;
  if (sheetTemsis && !isSameCode(sheetTemsis, entry.temsis)) {
    throw new Error(`開到的紀錄表 TEMSIS（${maskCode(sheetTemsis)}）跟要比對的不一樣，這次不比`);
  }

  const closedFile = revisionFileNames(entry.temsis, entry.version).closed;
  try {
    await fs.mkdir(PATHS.revisionDir, { recursive: true });
    await fs.writeFile(path.join(PATHS.revisionDir, closedFile), sheet.bytes);
  } catch (error) {
    throw new Error(`結案後的紀錄表存不進本機（${closedFile}）：${error instanceof Error ? error.message : error}`);
  }
  const beforeItems = await readLocalSheetItems(entry.backupFile);
  const afterItems = await extractPdfItems(sheet.bytes, { maxPages: UNLOCK.revision.maxPdfPages });
  return { ...checked, ...(await compareAndReport(entry, { beforeItems, afterItems, closedFile })) };
}

/**
 * 這一版還沒等到結案就又被解鎖了（有下一版）：下一版的備份就是那次結案時的內容，
 * 直接拿兩份本機檔比，不必回系統。
 */
async function compareOffline(entry, next) {
  log.info(
    `　TEMSIS ${maskCode(entry.temsis)}：${entry.remark} 之後又被解鎖過（${next.remark}），`
      + '直接拿兩份備份比對',
  );
  const beforeItems = await readLocalSheetItems(entry.backupFile);
  const afterItems = await readLocalSheetItems(next.backupFile);
  return compareAndReport(entry, { beforeItems, afterItems, closedFile: next.backupFile });
}

/** 失敗一次：累計次數，太多次就不再追（要人來看）。 */
function failurePatch(entry, error) {
  const reason = error instanceof Error ? error.message : String(error);
  const failCount = (entry.failCount ?? 0) + 1;
  const gaveUp = failCount >= UNLOCK.revision.maxFailures;
  log.warn(
    `　TEMSIS ${maskCode(entry.temsis)}：這次沒比成（${reason}）`
      + (gaveUp ? `。已連續失敗 ${failCount} 次，先不追了，請自行到系統比對` : '，下次再試'),
  );
  return {
    lastCheckedAt: new Date().toISOString(),
    failCount,
    lastError: reason,
    ...(gaveUp ? { state: 'gaveUp', cloudSynced: !entry.requestId } : {}),
  };
}

/** 把狀態有變的幾件寫回雲端工單（沒有雲端連線就留到下一次）。 */
async function syncCloud(queue) {
  const tracker = await loadTracker(TRACKER_FILE);
  const pending = tracker.entries.filter((entry) => entry.requestId && !entry.cloudSynced);
  if (pending.length === 0) return;
  if (!queue) {
    log.info(`有 ${pending.length} 件的比對結果還沒寫回網頁，下次開線上解鎖工具時會補寫。`);
    return;
  }
  for (const entry of pending) {
    if (await saveRevision(queue, entry.requestId, toCloudRevision(entry))) {
      await updateTrackedEntry(TRACKER_FILE, keyOf(entry), { cloudSynced: true });
    }
  }
}

/**
 * 跑一輪結案確認與比對。
 *
 * @param {import('./session.mjs').EmsSession} session 已登入的救護系統
 * @param {{queue?: import('./unlockQueue.mjs').QueueSession|null}} [options]
 *   `queue`：雲端連線（線上工單的比對結果要寫回網頁）；沒有就只做本機，雲端下次補寫
 * @returns {Promise<{checked: number, compared: number}>} 絕不丟例外
 */
export async function checkRevisionsSafely(session, options = {}) {
  const summary = { checked: 0, compared: 0 };
  try {
    const now = new Date();
    const work = planRevisionWork(await loadTracker(TRACKER_FILE), now, UNLOCK.revision);
    const total = work.toCheck.length + work.toCompareOffline.length + work.toExpire.length;
    if (total > 0) {
      log.step(`確認解鎖過的案件結案了沒（追蹤中 ${work.toCheck.length} 件）`);
      await runWork(session, work, summary);
    }
    await syncCloud(options.queue ?? null);
  } catch (error) {
    log.warn(`結案後比對沒有跑完（不影響解鎖）：${error instanceof Error ? error.message : error}`);
  }
  return summary;
}

/** 依計畫逐件處理；每做完一件就存一次追蹤清單，中途被關掉也不會白做。 */
async function runWork(session, work, summary) {
  for (const entry of work.toExpire) {
    log.warn(
      `　TEMSIS ${maskCode(entry.temsis)}：解鎖超過 ${UNLOCK.revision.maxWaitDays} 天都沒結案，不再追蹤`
        + `（最後看到的救護狀態：${entry.lastStatus ?? '沒查到過'}）`,
    );
    await updateTrackedEntry(TRACKER_FILE, keyOf(entry), { state: 'expired', cloudSynced: !entry.requestId });
  }
  for (const { entry, next } of work.toCompareOffline) {
    const patch = await compareOffline(entry, next).catch((error) => failurePatch(entry, error));
    await updateTrackedEntry(TRACKER_FILE, keyOf(entry), patch);
    if (patch.state === 'compared') summary.compared += 1;
  }
  for (const entry of work.toCheck) {
    const patch = await checkOne(session, entry).catch((error) => failurePatch(entry, error));
    await updateTrackedEntry(TRACKER_FILE, keyOf(entry), patch);
    summary.checked += 1;
    if (patch.state === 'compared') summary.compared += 1;
  }
  log.info(`結案確認完成：查了 ${summary.checked} 件，其中 ${summary.compared} 件已結案並比對完。`);
}
