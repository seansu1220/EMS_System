/**
 * 解鎖修改紀錄（v1.56.0，使用者 2026-11-03 指定）：每月初匯出一段期間內解鎖過的案件。
 *
 * 報表四個分頁：
 *   1. 摘要：期間、解鎖件數、未結案／已結案件數、有改動的件數
 *   2. 未結案：哪幾件解鎖後還沒結案（含最近一次確認的救護狀態、申請事由）
 *   3. 已結案-申請事由：已結案的每一件，申請人輸入的事由與修改處數
 *   4. 已結案-修改內容：已結案的每一件改了哪裡（**原內容 → 修改後的內容**，一處一列）
 *
 * 期間以**解鎖時間**（追蹤清單的 `unlockedAt`，本機時區）判斷，起訖日都含。
 * 結案前又解鎖一次的（`superseded`）不列，以最後一次解鎖為準，免得同一件出現兩次。
 *
 * 修改內容是拿本機存著的「解鎖前備份」與「結案後」兩份 PDF 重新比對出來的（同 `revisionCheck.mjs`），
 * 所以**不必登入救護系統**；申請事由不在追蹤清單裡，從雲端工單補讀（讀不到就註明）。
 *
 * ⚠ 個資：修改內容含病患姓名、身分證等**完整內容**，因此只寫在 `out/internal/解鎖修改紀錄/`，
 *   **不上雲**（使用者選定只做電腦端完整版）；終端機一律只印末 4 碼與件數，
 *   回寫網頁的也只有檔名（只含日期）與件數。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PATHS, UNLOCK } from './config.mjs';
import { buildCustomRange } from './dateRange.mjs';
import { buildListSheet } from './ekgLists.mjs';
import { log } from './logger.mjs';
import { readLocalSheetItems } from './revisionCheck.mjs';
import { loadTracker, localDateKey } from './revisionTrack.mjs';
import { TRACKER_FILE } from './sheetBackup.mjs';
import { describeChanges } from './sheetDiff.mjs';
import { maskCode } from './sheetFields.mjs';
import {
  fetchRequestDetails,
  fetchRevisionReportRequest,
  markRevisionReportRunning,
  saveRevisionReportResult,
} from './unlockQueue.mjs';

/** 各分頁的欄位（順序即輸出順序）。 */
export const OPEN_COLUMNS = [
  'TEMSIS', '案件日期', '出勤車輛', '分隊', '解鎖時間', '最近確認時間', '最近看到的救護狀態', '申請人', '申請事由', '備註',
];
export const REASON_COLUMNS = [
  'TEMSIS', '案件日期', '出勤車輛', '分隊', '申請人', '申請事由', '解鎖時間', '比對時間', '修改處數',
];
export const CHANGE_COLUMNS = ['TEMSIS', '案件日期', '出勤車輛', '項次', '欄位', '原內容', '修改後內容'];

/** 算未結案的追蹤狀態（`expired`、`gaveUp` 目前不會出現，見 TOOLS_SPEC 2.13，出現時照樣要列出來）。 */
const OPEN_STATES = ['waiting', 'expired', 'gaveUp'];

/**
 * @typedef {Object} RequestDetail 雲端工單上補讀的申請資料
 * @property {string} reason 申請事由
 * @property {string} requestedByName 申請人
 */

/**
 * @typedef {Object} ChangeRow 修改內容的一列
 * @property {string} field 欄位（判斷不出時寫明）
 * @property {string} before 原內容
 * @property {string} after 修改後內容
 */

/**
 * @typedef {Object} ClosedCase 已結案的一件
 * @property {import('./revisionTrack.mjs').RevisionEntry} entry
 * @property {ChangeRow[]|null} rows 修改內容；讀不到本機檔案時為 null
 * @property {string|null} error 讀不到本機檔案的原因
 */

/**
 * @typedef {Object} ReportResult 回寫網頁用（**不含病患資料**）
 * @property {string} fileName 檔名（只含期間）
 * @property {string} filePath 完整路徑（只在本機用）
 * @property {number} openCount 未結案件數
 * @property {number} closedCount 已結案件數
 * @property {number} changedCount 已結案而且有改動的件數
 */

/** ISO 時間 → 本機時區的「YYYY-MM-DD HH:mm」；空值回傳空字串。 */
export function formatLocalDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${localDateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 挑出期間內解鎖的追蹤項目（純函式）：依解鎖時間（本機時區）判斷，起訖日都含；
 * 結案前又解鎖一次的舊版本不列；依解鎖時間排序。
 *
 * @param {import('./revisionTrack.mjs').RevisionEntry[]} entries
 * @param {{start: string, end: string}} range `YYYY-MM-DD`
 * @returns {import('./revisionTrack.mjs').RevisionEntry[]}
 */
export function selectEntriesInRange(entries, range) {
  return entries
    .filter((entry) => entry.state !== 'superseded' && entry.unlockedAt)
    .filter((entry) => {
      const day = localDateKey(new Date(entry.unlockedAt));
      return day >= range.start && day <= range.end;
    })
    .sort((left, right) => left.unlockedAt.localeCompare(right.unlockedAt));
}

/**
 * 分成未結案與已結案（純函式）。
 * @param {import('./revisionTrack.mjs').RevisionEntry[]} entries
 */
export function classifyEntries(entries) {
  return {
    open: entries.filter((entry) => OPEN_STATES.includes(entry.state)),
    closed: entries.filter((entry) => entry.state === 'compared'),
  };
}

/** 一格太長就截斷（Excel 一格有上限，PDF 有時整頁擠在一行）。 */
function clipCell(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…（後面省略）` : text;
}

/**
 * 一處不同 → 報表上的列（純函式）。
 *
 * 判斷得出欄位（`inline`）而且有逐欄的改前改後時，一個欄位一列，最好讀；
 * 否則整段原文照列，欄位寫「附近」或「未能判斷欄位」，交給人判斷。
 *
 * @param {import('./sheetDiff.mjs').SheetChange} change
 * @param {number} maxLength 一格最多幾個字
 * @returns {ChangeRow[]}
 */
export function toChangeRows(change, maxLength) {
  const show = (parts) => clipCell(parts.filter(Boolean).join(' ').trim(), maxLength) || '（空白）';
  if (change.kind === 'checkbox') {
    return [{ field: `勾選${change.option ? `「${change.option}」` : '（認不出是哪一項）'}`, before: show(change.before), after: show(change.after) }];
  }
  if (change.fieldSource === 'inline' && change.segments.length > 0) {
    return change.segments.map((segment) => ({
      field: segment.label,
      before: show([segment.before]),
      after: show([segment.after]),
    }));
  }
  const field = change.fieldSource === 'unknown' || change.fields.length === 0
    ? '未能判斷欄位'
    : `${change.fields.join('、')}${change.fieldSource === 'nearby' ? '（附近）' : ''}`;
  return [{ field, before: show(change.before), after: show(change.after) }];
}

/** 申請人與事由（純函式）：線上工單從雲端補讀，本機手動解鎖的沒有事由。 */
function describeRequest(entry, details) {
  if (!entry.requestId) return { requestedByName: '（本機手動解鎖）', reason: '（本機手動解鎖，沒有線上申請事由）' };
  if (!details) return { requestedByName: '', reason: '（沒連上雲端，讀不到事由）' };
  return details.get(entry.requestId) ?? { requestedByName: '', reason: '（雲端讀不到這張工單）' };
}

/** 未結案那一列的備註。 */
function openNote(entry) {
  if (entry.state === 'expired') return '解鎖太久沒結案，已停止追蹤';
  if (entry.state === 'gaveUp') return '比對一直失敗，請到系統核對';
  return entry.lastCheckedAt ? '' : '還沒確認過結案狀態';
}

/**
 * 未結案分頁的資料列（純函式）。
 * @param {import('./revisionTrack.mjs').RevisionEntry[]} open
 * @param {Map<string, RequestDetail>|null} details
 */
export function buildOpenRows(open, details) {
  return open.map((entry) => {
    const request = describeRequest(entry, details);
    return [
      entry.temsis, entry.caseDate ?? '', entry.vehicle ?? '', entry.squad ?? '',
      formatLocalDateTime(entry.unlockedAt), formatLocalDateTime(entry.lastCheckedAt), entry.lastStatus ?? '',
      request.requestedByName, request.reason, openNote(entry),
    ];
  });
}

/**
 * 已結案-申請事由分頁的資料列（純函式）。
 * @param {ClosedCase[]} closed
 * @param {Map<string, RequestDetail>|null} details
 */
export function buildReasonRows(closed, details) {
  return closed.map(({ entry, rows }) => {
    const request = describeRequest(entry, details);
    const count = rows ? rows.length : entry.changeCount;
    return [
      entry.temsis, entry.caseDate ?? '', entry.vehicle ?? '', entry.squad ?? '',
      request.requestedByName, request.reason,
      formatLocalDateTime(entry.unlockedAt), formatLocalDateTime(entry.comparedAt), count ?? '',
    ];
  });
}

/**
 * 已結案-修改內容分頁的資料列（純函式）：每一件至少一列，沒改動、讀不到檔案也寫明。
 * @param {ClosedCase[]} closed
 */
export function buildChangeRows(closed) {
  return closed.flatMap(({ entry, rows, error }) => {
    const head = [entry.temsis, entry.caseDate ?? '', entry.vehicle ?? ''];
    if (!rows) return [[...head, '', '（讀不到本機的紀錄表檔案，無法列出）', error ?? '', '']];
    if (rows.length === 0) return [[...head, '', '（解鎖後沒有改動任何內容）', '', '']];
    return rows.map((row, index) => [...head, index + 1, row.field, row.before, row.after]);
  });
}

/** 摘要分頁的資料列（純函式）。 */
export function buildSummaryRows(range, open, closed) {
  const changed = closed.filter((item) => item.rows === null || item.rows.length > 0).length;
  return [
    ['期間（依解鎖時間，含起訖日）', `${range.start} ~ ${range.end}`],
    ['解鎖件數', `${open.length + closed.length} 件`],
    ['未結案', `${open.length} 件`],
    ['已結案', `${closed.length} 件（有改動 ${changed} 件、沒有改動 ${closed.length - changed} 件）`],
    ['說明', '結案前又解鎖一次的，以最後一次解鎖為準；11/3 13:40 以前送出的申請不追蹤，不會出現在這裡'],
    ['⚠ 個資', '本檔含病患資料，只供救護科內部核對，請勿外傳'],
  ];
}

/**
 * 重新比對一件已結案的（讀本機的兩份 PDF）。讀不到檔案不丟例外，回傳原因。
 * @param {import('./revisionTrack.mjs').RevisionEntry} entry
 * @returns {Promise<ClosedCase>}
 */
async function loadClosedCase(entry) {
  const config = UNLOCK.revision;
  try {
    if (!entry.closedFile) throw new Error('追蹤清單沒有記錄結案後的檔案');
    const [beforeItems, afterItems] = await Promise.all([
      readLocalSheetItems(entry.backupFile),
      readLocalSheetItems(entry.closedFile),
    ]);
    const changes = describeChanges(beforeItems, afterItems, config);
    const rows = changes.flatMap((change) => toChangeRows(change, config.monthlyReport.maxCellLength));
    return { entry, rows, error: null };
  } catch (error) {
    log.warn(`　TEMSIS ${maskCode(entry.temsis)}：讀不到本機紀錄表，報表上會註明`);
    return { entry, rows: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 組出報表活頁簿（不寫檔）。
 * @param {{start: string, end: string}} range
 * @param {{open: import('./revisionTrack.mjs').RevisionEntry[], closed: ClosedCase[]}} cases
 * @param {Map<string, RequestDetail>|null} details
 * @returns {ExcelJS.Workbook}
 */
export function buildRevisionReportWorkbook(range, cases, details) {
  const workbook = new ExcelJS.Workbook();
  const period = `${range.start} ~ ${range.end}`;
  buildListSheet(workbook, '摘要', `解鎖修改紀錄（${period}）`, ['項目', '內容'], buildSummaryRows(range, cases.open, cases.closed));
  buildListSheet(workbook, '未結案', `解鎖後未結案（${cases.open.length} 件）`, OPEN_COLUMNS, buildOpenRows(cases.open, details), {
    wideColumns: ['申請事由', '備註'],
  });
  buildListSheet(
    workbook, '已結案-申請事由', `已結案的申請事由（${cases.closed.length} 件）`,
    REASON_COLUMNS, buildReasonRows(cases.closed, details), { wideColumns: ['申請事由'] },
  );
  const changeSheet = buildListSheet(
    workbook, '已結案-修改內容', '已結案的修改內容（原內容 → 修改後的內容）',
    CHANGE_COLUMNS, buildChangeRows(cases.closed), { wideColumns: ['原內容', '修改後內容'] },
  );
  // 原內容可能很長，開自動換行才看得到全部。
  for (const column of ['原內容', '修改後內容']) {
    changeSheet.getColumn(CHANGE_COLUMNS.indexOf(column) + 1).alignment = { wrapText: true, vertical: 'top' };
  }
  changeSheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: CHANGE_COLUMNS.length } };
  return workbook;
}

/**
 * 產出解鎖修改紀錄並寫檔。
 *
 * @param {{start: string, end: string}} range
 * @param {{queue?: import('./unlockQueue.mjs').QueueSession|null}} [options] 連得上雲端才補得到申請事由
 * @returns {Promise<ReportResult>}
 * @throws 追蹤清單讀不到、檔案寫不進去（例如正被 Excel 開著）時
 */
export async function writeRevisionReport(range, options = {}) {
  const config = UNLOCK.revision.monthlyReport;
  const tracker = await loadTracker(TRACKER_FILE);
  const { open, closed } = classifyEntries(selectEntriesInRange(tracker.entries, range));
  log.step(`解鎖修改紀錄：${range.start} ~ ${range.end}（未結案 ${open.length} 件、已結案 ${closed.length} 件）`);

  const queue = options.queue ?? null;
  const requestIds = [...open, ...closed].map((entry) => entry.requestId).filter(Boolean);
  const details = queue ? await fetchRequestDetails(queue, requestIds) : null;
  const closedCases = [];
  for (const entry of closed) closedCases.push(await loadClosedCase(entry));

  const fileName = `${config.fileNamePrefix}_${range.start}至${range.end}.xlsx`;
  const outputDir = path.join(PATHS.internalDir, config.dirName);
  const filePath = path.join(outputDir, fileName);
  await fs.mkdir(outputDir, { recursive: true });
  try {
    await buildRevisionReportWorkbook(range, { open, closed: closedCases }, details).xlsx.writeFile(filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(`${fileName} 正被其他程式開啟（通常是 Excel），無法覆寫。請關閉後再匯出一次。`);
    }
    throw new Error(`解鎖修改紀錄寫不進本機（revisionMonthly.writeRevisionReport）：${error instanceof Error ? error.message : error}`);
  }
  log.ok(`已產出：${path.relative(process.cwd(), filePath)}`);
  log.info('（含病患資料，只供救護科內部核對，請勿外傳）');
  const changedCount = closedCases.filter((item) => item.rows === null || item.rows.length > 0).length;
  return { fileName, filePath, openCount: open.length, closedCount: closed.length, changedCount };
}

/**
 * 網頁上管理員按了「匯出」就產出一份（監看每一輪呼叫；**絕不丟例外**）。
 *
 * 不需要登入救護系統（只讀本機檔案＋雲端工單）。回寫網頁的只有檔名、件數，
 * 失敗時也只寫固定說法——錯誤原文可能含檔名裡的 TEMSIS，不上雲。
 *
 * @param {import('./unlockQueue.mjs').QueueSession} queue
 * @returns {Promise<boolean>} 這一輪有沒有處理請求
 */
export async function handleRevisionReportRequest(queue) {
  const request = await fetchRevisionReportRequest(queue);
  if (!request) return false;
  log.step('管理員在網頁上要求匯出解鎖修改紀錄');
  await markRevisionReportRunning(queue, request.requestedAt);
  try {
    const range = buildCustomRange(request.rangeStart, request.rangeEnd);
    const result = await writeRevisionReport(range, { queue });
    await saveRevisionReportResult(queue, { ok: true, ...result, errorMessage: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`解鎖修改紀錄沒有產出：${message}`);
    const busy = message.includes('正被其他程式開啟');
    await saveRevisionReportResult(queue, {
      ok: false,
      errorMessage: busy
        ? '同一個期間的報表正被 Excel 開著，請在救護科電腦關掉後再匯出一次'
        : '產出失敗，原因請看救護科電腦的監看視窗',
    });
  }
  return true;
}
