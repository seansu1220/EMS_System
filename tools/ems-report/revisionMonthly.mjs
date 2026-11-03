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
 * 輸出（v1.57.0，使用者 2026-11-03：要用資料夾分類，看總表時才好對照原表）：每個期間一個資料夾
 *   `out/internal/解鎖修改紀錄/{起日}至{迄日}/`
 *     解鎖修改紀錄_{起日}至{迄日}.xlsx   ← 總表；第一欄「編號」點下去就開那一件的原表資料夾
 *     未結案/{編號}_{TEMSIS}/解鎖前.pdf
 *     已結案/{編號}_{TEMSIS}/解鎖前.pdf、結案後.pdf、差異說明.txt
 * 原表是從 `解鎖前後比對/` 複製過來的，整個期間資料夾搬走或交給別人看時，連結照樣點得開。
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
import { TRACKER_FILE, organizeRevisionFiles, revisionFilePath } from './revisionFiles.mjs';
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
  '編號', 'TEMSIS', '案件日期', '出勤車輛', '分隊', '解鎖時間', '最近確認時間', '最近看到的救護狀態', '申請人', '申請事由', '備註',
];
export const REASON_COLUMNS = [
  '編號', 'TEMSIS', '案件日期', '出勤車輛', '分隊', '申請人', '申請事由', '解鎖時間', '比對時間', '修改處數',
];
export const CHANGE_COLUMNS = ['編號', 'TEMSIS', '案件日期', '出勤車輛', '項次', '欄位', '原內容', '修改後內容'];

/** 編號欄的超連結樣式（跟 Excel 內建的超連結一樣藍色底線）。 */
const LINK_FONT = { color: { argb: 'FF0563C1' }, underline: true };

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
 * @property {string} fileName 總表檔名（只含期間；放在同名期間資料夾裡）
 * @property {string} filePath 總表完整路徑（只在本機用）
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

/**
 * 第幾件的編號（純函式）：補零到至少 2 位，件數破百就補到 3 位，資料夾才排得整齊。
 * @param {number} index 從 0 起算
 * @param {number} total 這一組總件數
 * @returns {string}
 */
export function caseNumber(index, total) {
  return String(index + 1).padStart(Math.max(2, String(total).length), '0');
}

/**
 * 這一件的原表資料夾，相對於總表所在的期間資料夾（純函式）：`已結案/01_{TEMSIS}`。
 * @param {string} group `UNLOCK.revision.monthlyReport.caseFolders` 的 open 或 closed
 * @param {string} number
 * @param {string} temsis
 * @returns {string}
 */
export function caseFolderPath(group, number, temsis) {
  return `${group}/${number}_${String(temsis).replace(/[^0-9A-Za-z]/g, '')}`;
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
  return open.map((entry, index) => {
    const request = describeRequest(entry, details);
    return [
      caseNumber(index, open.length), entry.temsis, entry.caseDate ?? '', entry.vehicle ?? '', entry.squad ?? '',
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
  return closed.map(({ entry, rows }, index) => {
    const request = describeRequest(entry, details);
    const count = rows ? rows.length : entry.changeCount;
    return [
      caseNumber(index, closed.length), entry.temsis, entry.caseDate ?? '', entry.vehicle ?? '', entry.squad ?? '',
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
  return closed.flatMap(({ entry, rows, error }, index) => {
    const head = [caseNumber(index, closed.length), entry.temsis, entry.caseDate ?? '', entry.vehicle ?? ''];
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
    ['原表', '每一件的原表放在這份總表旁邊的「未結案」「已結案」資料夾，資料夾名稱開頭就是編號；各分頁點「編號」可直接開啟'],
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
 * 把第一欄的編號變成超連結，點下去開這一件的原表資料夾（相對路徑，整個期間資料夾搬走也點得開）。
 * 第二欄是 TEMSIS（各分頁的欄位順序都是「編號、TEMSIS、…」）。
 *
 * @param {ExcelJS.Worksheet} sheet
 * @param {string} group
 */
function linkCaseNumbers(sheet, group) {
  // 第 1 列是大標、第 2 列是欄名，資料從第 3 列開始。
  for (let rowNumber = 3; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const number = String(row.getCell(1).value ?? '');
    const temsis = String(row.getCell(2).value ?? '');
    if (!number || !temsis) continue;
    row.getCell(1).value = { text: number, hyperlink: caseFolderPath(group, number, temsis) };
    row.getCell(1).font = LINK_FONT;
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
  const { caseFolders } = UNLOCK.revision.monthlyReport;
  buildListSheet(workbook, '摘要', `解鎖修改紀錄（${period}）`, ['項目', '內容'], buildSummaryRows(range, cases.open, cases.closed));
  const openSheet = buildListSheet(
    workbook, '未結案', `解鎖後未結案（${cases.open.length} 件）`, OPEN_COLUMNS, buildOpenRows(cases.open, details),
    { wideColumns: ['申請事由', '備註'] },
  );
  linkCaseNumbers(openSheet, caseFolders.open);
  const reasonSheet = buildListSheet(
    workbook, '已結案-申請事由', `已結案的申請事由（${cases.closed.length} 件）`,
    REASON_COLUMNS, buildReasonRows(cases.closed, details), { wideColumns: ['申請事由'] },
  );
  linkCaseNumbers(reasonSheet, caseFolders.closed);
  const changeSheet = buildListSheet(
    workbook, '已結案-修改內容', '已結案的修改內容（原內容 → 修改後的內容）',
    CHANGE_COLUMNS, buildChangeRows(cases.closed), { wideColumns: ['原內容', '修改後內容'] },
  );
  // 原內容可能很長，開自動換行才看得到全部。
  for (const column of ['原內容', '修改後內容']) {
    changeSheet.getColumn(CHANGE_COLUMNS.indexOf(column) + 1).alignment = { wrapText: true, vertical: 'top' };
  }
  changeSheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: CHANGE_COLUMNS.length } };
  linkCaseNumbers(changeSheet, caseFolders.closed);
  return workbook;
}

/**
 * 這一件要複製哪些原表（純函式）：未結案只有解鎖前，已結案再加結案後與差異說明。
 * @param {import('./revisionTrack.mjs').RevisionEntry} entry
 * @param {boolean} closed
 * @returns {{source: string, name: string}[]} source＝相對 `解鎖前後比對/` 的路徑
 */
export function caseFilesToCopy(entry, closed) {
  const { caseFiles } = UNLOCK.revision.monthlyReport;
  const files = [{ source: entry.backupFile, name: caseFiles.backup }];
  if (closed) {
    files.push({ source: entry.closedFile, name: caseFiles.closed }, { source: entry.reportFile, name: caseFiles.report });
  }
  return files.filter((file) => file.source);
}

/**
 * 把原表複製到期間資料夾的「未結案」「已結案」底下（每件一個資料夾，開頭是編號）。
 *
 * 先清掉上次匯出同一期間留下的這兩個資料夾：案件可能從未結案變成已結案，舊的留著會兩邊都有。
 * 某個檔複製不了（例如本機已被刪掉）只記件數，不擋整份報表。
 *
 * @param {string} outputDir 期間資料夾
 * @param {import('./revisionTrack.mjs').RevisionEntry[]} open
 * @param {import('./revisionTrack.mjs').RevisionEntry[]} closed
 * @returns {Promise<number>} 複製不了的檔數
 */
async function exportCaseFiles(outputDir, open, closed) {
  const { caseFolders } = UNLOCK.revision.monthlyReport;
  const groups = [
    { folder: caseFolders.open, entries: open, closed: false },
    { folder: caseFolders.closed, entries: closed, closed: true },
  ];
  let missing = 0;
  for (const group of groups) {
    await fs.rm(path.join(outputDir, group.folder), { recursive: true, force: true });
    for (const [index, entry] of group.entries.entries()) {
      const relative = caseFolderPath(group.folder, caseNumber(index, group.entries.length), entry.temsis);
      const caseDir = path.join(outputDir, ...relative.split('/'));
      await fs.mkdir(caseDir, { recursive: true });
      for (const file of caseFilesToCopy(entry, group.closed)) {
        await fs.copyFile(revisionFilePath(file.source), path.join(caseDir, file.name)).catch(() => {
          missing += 1;
        });
      }
    }
  }
  return missing;
}

/**
 * 產出解鎖修改紀錄並寫檔（總表＋原表資料夾）。
 *
 * @param {{start: string, end: string}} range
 * @param {{queue?: import('./unlockQueue.mjs').QueueSession|null}} [options] 連得上雲端才補得到申請事由
 * @returns {Promise<ReportResult>}
 * @throws 追蹤清單讀不到、檔案寫不進去（例如正被 Excel 開著）時
 */
export async function writeRevisionReport(range, options = {}) {
  const config = UNLOCK.revision.monthlyReport;
  await organizeRevisionFiles();
  const tracker = await loadTracker(TRACKER_FILE);
  const { open, closed } = classifyEntries(selectEntriesInRange(tracker.entries, range));
  log.step(`解鎖修改紀錄：${range.start} ~ ${range.end}（未結案 ${open.length} 件、已結案 ${closed.length} 件）`);

  const queue = options.queue ?? null;
  const requestIds = [...open, ...closed].map((entry) => entry.requestId).filter(Boolean);
  const details = queue ? await fetchRequestDetails(queue, requestIds) : null;
  const closedCases = [];
  for (const entry of closed) closedCases.push(await loadClosedCase(entry));

  const periodName = `${range.start}至${range.end}`;
  const fileName = `${config.fileNamePrefix}_${periodName}.xlsx`;
  const outputDir = path.join(PATHS.internalDir, config.dirName, periodName);
  const filePath = path.join(outputDir, fileName);
  try {
    await fs.mkdir(outputDir, { recursive: true });
    // 先寫總表：被 Excel 開著時在這裡就停，不會先把上次的原表資料夾清掉。
    await buildRevisionReportWorkbook(range, { open, closed: closedCases }, details).xlsx.writeFile(filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(`${fileName} 正被其他程式開啟（通常是 Excel），無法覆寫。請關閉後再匯出一次。`);
    }
    throw new Error(`解鎖修改紀錄寫不進本機（revisionMonthly.writeRevisionReport）：${error instanceof Error ? error.message : error}`);
  }
  const missing = await exportCaseFiles(outputDir, open, closed).catch((error) => {
    throw new Error(`原表資料夾整理失敗（revisionMonthly.exportCaseFiles）：${error instanceof Error ? error.message : error}`);
  });
  log.ok(`已產出：${path.relative(process.cwd(), outputDir)}（總表＋未結案／已結案原表資料夾）`);
  if (missing > 0) log.warn(`有 ${missing} 個原表檔在本機找不到，沒有複製到資料夾`);
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
