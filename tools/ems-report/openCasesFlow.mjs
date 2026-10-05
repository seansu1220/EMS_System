/**
 * 未結案案件統整（第 9 章）的**頁面操作**——依使用者 2026-10-05 交代的步驟：
 *
 *   1. 救護紀錄表查詢 → 進階搜尋「救護狀態＝未結案」→ 使用者指定的日期範圍 → 查詢
 *   2. 逐筆開「救護紀錄PDF(桃)」，記下**救災救護指揮中心指派案號**
 *   3. 全部記完後改到左側「案件列表」，以案號查詢（應該只會查到一件）→ 點「救護紀錄」
 *   4. 案件內部有幾張紀錄表、各自的救護表狀態 → 統整成 `已結案*1+已填寫*2+未填寫*1`
 *
 * 第 1 步刻意改成「查詢後**匯出 Excel**」取清單，而不是直接在結果頁上一列一列點：
 * 結果頁一頁只列 30 筆（探測到的結果表 31 列含標題），要翻頁才看得到其餘的，
 * 匯出檔則是整批。拿到 TEMSIS 清單後再一筆一筆查回來開 PDF——這是心電圖逐案查核
 * 跑了好幾個月的同一條路（`ekgVerify.mjs`），開 PDF、進案件內部也都沿用解鎖流程的實作。
 *
 * ⚠ 這支**只讀不寫**：不按任何會改動系統資料的按鈕（「調整為未結案」那些一律不碰）。
 *
 * ⚠ 個資原則：
 *   - 匯出檔含個案明細，只落在 `out/raw/`，取出 TEMSIS／分隊／日期三欄後就刪（`--keep-raw` 才留）
 *   - 紀錄表 PDF 全文只在記憶體，只取指派案號與 TEMSIS
 *   - 案件內部只讀項次／日期／派遣車輛／派遣分隊／救護表狀態五欄
 *   - 進度檔與報表含完整編號，只落在 `out/internal/`；終端機與 log 一律只印末 4 碼
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  OPEN_CASES,
  PATHS,
  SITE,
  SQUAD_COLUMN_CANDIDATES,
  TEMSIS_COLUMN_CANDIDATES,
  UNLOCK,
} from './config.mjs';
import { resolveColumnByNames } from './aggregate.mjs';
import {
  content,
  applyDateRange,
  applyTextCondition,
  findClickablesWithRetry,
  submitQuery,
  openCaseByDispatchNo,
} from './caseFlow.mjs';
import { formatDateForSite, padRange } from './dateRange.mjs';
import { detectDateFormat, fillField, selectField } from './formFill.mjs';
import { log } from './logger.mjs';
import { gotoRecordQuery, ensureFieldVisible } from './navigation.mjs';
import {
  buildCaseSummary,
  buildRecordList,
  groupByDispatchNo,
  isProgressUsable,
  normalizeStatus,
} from './openCases.mjs';
import {
  findPairedRows,
  findRowsWithColumnValue,
  groupByRow,
  listTableHeaders,
} from './pageFinder.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import { exportExcelWithRetry, runQuery } from './scrape.mjs';
import { extractLabeledCode, isSameCode, maskCode } from './sheetFields.mjs';
import { readTable } from './workbook.mjs';

/**
 * @typedef {Object} OpenCaseResult 整個流程跑完的結果（交給 `openCasesReport.mjs` 輸出）
 * @property {number} recordCount 查詢撈到的未結案紀錄表筆數（套用 --limit 之前）
 * @property {import('./openCases.mjs').RecordLookup[]} lookups 這次處理的每一張紀錄表
 * @property {import('./openCases.mjs').CaseSummary[]} summaries 每一件案子的統整
 * @property {boolean} aborted 是否因連續失敗而中途停下
 * @property {number} skipped 依 --limit 沒處理的筆數
 */

/** 取錯誤訊息文字。 */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 查詢結果是不是「查無資料」。是的話不必按匯出（按了只會拿到空檔或錯誤）。 */
async function hasNoResult(page) {
  const marker = content(page).getByText(SITE.noResultMarker, { exact: false }).first();
  return (await marker.count().catch(() => 0)) > 0;
}

/**
 * 步驟 1：救護紀錄表查詢，條件設成「指定期間＋救護狀態＝未結案」，查詢後匯出。
 *
 * 送醫情形與院前預警**明確設成不限**，不靠「應該是空的」：這一頁的條件會跨查詢留著
 * （第 8 章就是這樣被上一輪的值害到，見 TOOLS_SPEC 8.5）。
 *
 * @returns {Promise<string|null>} 匯出檔路徑；查無資料時為 null
 */
async function exportOpenRecords(context, page, range) {
  log.step('開啟救護紀錄表查詢');
  await gotoRecordQuery(page);
  const dateFormat = await detectDateFormat(content(page), SITE.queryFields.dateFrom, SITE.defaultDateFormat);
  await fillField(content(page), SITE.queryFields.dateFrom, formatDateForSite(range.start, dateFormat), '起日');
  // 迄日必須是 23:59:59，否則格式含時間時會變成當天 00:00:00，漏掉整個最後一天。
  await fillField(
    content(page),
    SITE.queryFields.dateTo,
    formatDateForSite(range.end, dateFormat, { endOfDay: true }),
    '迄日',
  );
  for (const [selector, label, value, shown] of [
    [SITE.queryFields.rescueStatus, '救護狀態', OPEN_CASES.rescueStatusValue, OPEN_CASES.rescueStatusLabel],
    [SITE.queryFields.transport, '送醫情形', '', '不限'],
    [SITE.queryFields.prehospitalAlert, '院前預警', '', '不限'],
  ]) {
    await ensureFieldVisible(page, selector);
    await selectField(content(page), selector, value, `${label}＝${shown}`);
  }

  log.info('按下查詢，等待結果');
  await runQuery(page);
  if (await hasNoResult(page)) return null;
  log.info('按下匯出EXCEL，等待下載');
  await fs.mkdir(PATHS.rawDir, { recursive: true });
  const targetPath = path.join(PATHS.rawDir, `${range.label}-open-records.xls`);
  return exportExcelWithRetry(context, page, targetPath);
}

/**
 * 回頭核對匯出檔：撈出來的應該全是未結案。
 *
 * 一大半不是 → 下拉根本沒選上，**中止**（整批跑下去要好幾個小時，結果卻是錯的）；
 * 只有少數不是 → 可能是查詢到匯出之間剛好有人結案，提醒就好。
 */
function verifyExportStatus(table) {
  const column = resolveColumnByNames(table.headers, OPEN_CASES.exportColumns.rescueStatus);
  if (!column) {
    log.warn('匯出檔沒有「救護狀態」欄，無法回頭核對查詢條件，請自行確認筆數是否合理');
    return;
  }
  const wanted = normalizeStatus(OPEN_CASES.rescueStatusLabel);
  const mismatched = table.rows.filter((row) => normalizeStatus(row[column.column]) !== wanted).length;
  if (mismatched === 0) {
    log.ok(`回頭核對：${table.rows.length} 筆的救護狀態全是「${OPEN_CASES.rescueStatusLabel}」`);
    return;
  }
  if (mismatched * 2 > table.rows.length) {
    throw new Error(
      `匯出的 ${table.rows.length} 筆裡有 ${mismatched} 筆的救護狀態不是「${OPEN_CASES.rescueStatusLabel}」，`
        + '查詢條件看起來沒有生效，已中止（不要拿錯的清單跑好幾個小時）',
    );
  }
  log.warn(
    `匯出的 ${table.rows.length} 筆裡有 ${mismatched} 筆的救護狀態不是「${OPEN_CASES.rescueStatusLabel}」`
      + '（可能是查詢到匯出之間剛好有人結案），照樣列入',
  );
}

/**
 * 讀匯出檔，取出要查指派案號的紀錄表清單。
 * @returns {{temsis: string, squad: string, caseDate: string}[]}
 */
function readRecordList(filePath) {
  const table = readTable(filePath, TEMSIS_COLUMN_CANDIDATES);
  const temsis = resolveColumnByNames(table.headers, TEMSIS_COLUMN_CANDIDATES);
  if (!temsis) {
    throw new Error(
      `匯出檔中找不到 TEMSIS 欄（試過：${TEMSIS_COLUMN_CANDIDATES.join('、')}）。`
        + `實際欄名有：${table.headers.join('、')}`,
    );
  }
  const squad = resolveColumnByNames(table.headers, SQUAD_COLUMN_CANDIDATES);
  const caseDate = resolveColumnByNames(table.headers, OPEN_CASES.exportColumns.caseDate);
  log.info(
    `匯出檔欄位：TEMSIS＝「${temsis.column}」、分隊＝「${squad?.column ?? '（找不到）'}」、`
      + `案件日期＝「${caseDate?.column ?? '（找不到）'}」`,
  );
  verifyExportStatus(table);
  return buildRecordList(table.rows, {
    temsis: temsis.column,
    squad: squad?.column ?? null,
    caseDate: caseDate?.column ?? null,
  });
}

/**
 * 步驟 2 的一筆：以 TEMSIS 查回紀錄表，開 PDF 讀指派案號。
 *
 * 紀錄表上的 TEMSIS 與要查的不一致就丟錯——那代表查詢條件沒生效或點錯列，
 * 讀到的案號是別人的（解鎖流程同一道防呆）。
 *
 * @returns {Promise<string>} 指派案號
 */
async function readDispatchNo(context, page, temsis, range) {
  await gotoRecordQuery(page);
  await applyDateRange(page, range);
  await applyTextCondition(page, UNLOCK.fieldLabels.temsis, temsis, 'TEMSIS');
  await submitQuery(page);
  const rows = groupByRow(await findClickablesWithRetry(page, UNLOCK.buttonTexts.openRecordSheet));
  if (rows.length === 0) {
    throw new Error('以 TEMSIS 查不到這張紀錄表（畫面可能還沒就緒）');
  }

  const sheet = await openRecordSheet(context, content(page), UNLOCK.buttonTexts.openRecordSheet, rows[0][0].index);
  const sheetTemsis = extractLabeledCode(sheet.text, UNLOCK.sheetLabels.temsis);
  if (sheetTemsis && !isSameCode(sheetTemsis.value, temsis)) {
    throw new Error(`紀錄表上的 TEMSIS（${maskCode(sheetTemsis.value)}）與要查的不符，已略過`);
  }
  const dispatchNo = extractLabeledCode(sheet.text, UNLOCK.sheetLabels.dispatchNo);
  if (!dispatchNo) {
    throw new Error(`紀錄表讀得到內容，但找不到「${UNLOCK.sheetLabels.dispatchNo[0]}」欄位（${sheet.kind}）`);
  }
  return dispatchNo.value;
}

/**
 * 步驟 3~4 的一件：以案號進入案件內部，讀出每一張紀錄表的救護表狀態。
 *
 * 另外數一次「救護紀錄」按鈕，跟讀到的列數互相核對（對不上會寫進報表的備註）。
 *
 * @returns {Promise<import('./openCases.mjs').CaseInspection>}
 */
async function readCaseStatuses(context, page, dispatchNo, range) {
  const opened = await openCaseByDispatchNo(
    context,
    page,
    dispatchNo,
    padRange(range, OPEN_CASES.caseListPaddingDays),
  );
  const paired = await findPairedRows(
    content(page),
    UNLOCK.buttonTexts.openRecordInCase,
    UNLOCK.buttonTexts.unlock,
    { recordExact: false },
  );
  const { status, wanted, maxRows } = OPEN_CASES.caseColumns;
  const found = await findRowsWithColumnValue(content(page), status, wanted, { maxRows });
  if (found.matched.length === 0) {
    const tables = await listTableHeaders(content(page)).catch(() => []);
    throw new Error(`案件內部讀不到「${status[0]}」欄（這一頁的表格：${tables.join('；') || '讀不到'}）`);
  }
  const rows = found.matched.map((item) => ({
    itemNo: item.values['項次'] ?? '',
    date: item.values['日期'] ?? '',
    vehicle: item.values['派遣車輛'] ?? '',
    squad: item.values['派遣分隊'] ?? '',
    status: item.values['救護表狀態'] ?? item.marker,
  }));
  return {
    dispatchNo,
    rows,
    buttonCount: paired.recordCount,
    caseListRows: opened?.rowCount ?? 1,
    error: null,
  };
}

/**
 * 失敗就重試（多半是畫面還沒就緒），重試完仍失敗就把最後一次的原因丟出去。
 * @template T
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
async function withRetry(page, action) {
  let lastError = null;
  for (let attempt = 1; attempt <= OPEN_CASES.maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < OPEN_CASES.maxAttempts) {
        log.warn(`第 ${attempt} 次失敗（${reasonOf(error)}），重試`);
        await page.waitForTimeout(OPEN_CASES.settleMs);
      }
    }
  }
  throw new Error(`已重試 ${OPEN_CASES.maxAttempts} 次：${reasonOf(lastError)}`);
}

/** 進度檔位置（含完整編號，放 internal）。 */
function progressFilePath(range) {
  return path.join(PATHS.internalDir, `${range.label}-${OPEN_CASES.progressName}.json`);
}

/**
 * 讀上次中斷的進度。不同期間、太舊、壞掉都當成沒有進度——
 * 狀態每天都在變，續跑是加分，不能拿舊資料充數。
 *
 * @returns {Promise<{lookups: Map<string, object>, inspections: Map<string, object>}>}
 */
async function loadProgress(range) {
  const empty = { lookups: new Map(), inspections: new Map() };
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(progressFilePath(range), 'utf8'));
  } catch {
    return empty;
  }
  if (!isProgressUsable(parsed, range.label, Date.now())) {
    log.info('上次的進度檔不是這個期間、或已超過 12 小時（狀態可能已變），從頭跑');
    return empty;
  }
  // 只沿用成功的；失敗的這次再試一次。
  const succeeded = (items, key) => new Map(
    (Array.isArray(items) ? items : []).filter((item) => item?.[key] && !item.error).map((item) => [item[key], item]),
  );
  return {
    lookups: succeeded(parsed.lookups, 'temsis'),
    inspections: succeeded(parsed.inspections, 'dispatchNo'),
  };
}

/** 每做完一筆就存一次進度。存檔失敗只警告：後果只是中斷後要從頭跑。 */
async function saveProgress(range, lookups, inspections) {
  try {
    await fs.mkdir(PATHS.internalDir, { recursive: true });
    const body = {
      rangeLabel: range.label,
      savedAt: new Date().toISOString(),
      lookups: [...lookups.values()],
      inspections: [...inspections.values()],
    };
    await fs.writeFile(progressFilePath(range), JSON.stringify(body, null, 2), 'utf8');
  } catch (error) {
    log.warn(`進度存檔失敗（不影響本次結果）：${reasonOf(error)}`);
  }
}

/** 跑完整份之後刪掉進度檔：留著的話，下次同一期間重跑會沿用今天的狀態。 */
export async function removeProgress(range) {
  await fs.rm(progressFilePath(range), { force: true }).catch(() => {});
}

/**
 * 逐筆跑一個階段（查案號、或進案件內部），連續失敗到上限就停下來。
 *
 * @template T
 * @param {{label: string, keys: string[], done: Map<string, T>, describe: (key: string) => string,
 *   run: (key: string) => Promise<T>, onFailure: (key: string, reason: string) => T,
 *   isFailure: (item: T) => boolean, save: () => Promise<void>, page: object}} stage
 * @returns {Promise<boolean>} 是否中途停下
 */
async function runStage(stage) {
  const pending = stage.keys.filter((key) => !stage.done.has(key));
  log.step(`${stage.label}（共 ${stage.keys.length} 筆，這次要跑 ${pending.length} 筆）`);
  if (pending.length < stage.keys.length) {
    log.ok(`接續上次的進度：${stage.keys.length - pending.length} 筆已經做過，直接沿用`);
  }
  let consecutiveFailures = 0;
  for (const [position, key] of pending.entries()) {
    log.step(`${stage.label} ${position + 1} / ${pending.length}：${stage.describe(key)}`);
    let item;
    try {
      item = await withRetry(stage.page, () => stage.run(key));
    } catch (error) {
      log.warn(`${maskCode(key)}：${reasonOf(error)}`);
      item = stage.onFailure(key, reasonOf(error));
    }
    stage.done.set(key, item);
    await stage.save();
    consecutiveFailures = stage.isFailure(item) ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= OPEN_CASES.abortAfterConsecutiveFailures) {
      log.warn(
        `連續 ${consecutiveFailures} 筆都失敗，先停下來（畫面可能已改版）。`
          + '已完成的進度都留著，12 小時內再跑一次會接著跑。',
      );
      return true;
    }
    await stage.page.waitForTimeout(OPEN_CASES.settleMs);
  }
  return false;
}

/**
 * 取得未結案紀錄表清單（查詢 → 匯出 → 讀出 → 刪掉原始檔）。
 * @returns {Promise<{temsis: string, squad: string, caseDate: string}[]>}
 */
async function fetchRecordList(session, range, options) {
  const filePath = await exportOpenRecords(session.context, session.page, range);
  if (!filePath) return [];
  try {
    return readRecordList(filePath);
  } finally {
    if (options.keepRaw) {
      log.warn(`依 --keep-raw 保留原始明細檔：${filePath}（含個資，請自行妥善處理）`);
    } else {
      await fs.rm(filePath, { force: true }).catch(() => {});
      log.ok('已刪除系統匯出的原始明細檔');
    }
  }
}

/**
 * 整個流程。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {import('./dateRange.mjs').MonthRange} range 使用者指定的期間
 * @param {{limit?: number, keepRaw?: boolean}} options `limit`＝只處理前幾張紀錄表（試跑用）
 * @returns {Promise<OpenCaseResult>}
 */
export async function runOpenCaseFlow(session, range, options = {}) {
  const records = await fetchRecordList(session, range, options);
  log.ok(`未結案紀錄表：${records.length} 筆`);
  const planned = typeof options.limit === 'number' ? records.slice(0, options.limit) : records;
  const skipped = records.length - planned.length;
  if (skipped > 0) log.warn(`依 --limit 只處理前 ${planned.length} 筆，其餘 ${skipped} 筆不會出現在報表上`);

  const progress = await loadProgress(range);
  const byTemsis = new Map(planned.map((record) => [record.temsis, record]));
  const save = () => saveProgress(range, progress.lookups, progress.inspections);

  const lookupAborted = await runStage({
    label: '讀指派案號',
    page: session.page,
    keys: planned.map((record) => record.temsis),
    done: progress.lookups,
    describe: (temsis) => `${byTemsis.get(temsis).squad || '分隊不明'}　${maskCode(temsis)}`,
    run: async (temsis) => {
      const dispatchNo = await readDispatchNo(session.context, session.page, temsis, range);
      log.ok(`指派案號：${maskCode(dispatchNo)}`);
      return { ...byTemsis.get(temsis), dispatchNo, error: null };
    },
    onFailure: (temsis, reason) => ({ ...byTemsis.get(temsis), dispatchNo: null, error: reason }),
    isFailure: (item) => Boolean(item.error),
    save,
  });

  const lookups = planned.map((record) => progress.lookups.get(record.temsis)
    ?? { ...record, dispatchNo: null, error: '這次沒有跑到（中途停止）' });
  const groups = groupByDispatchNo(lookups);
  log.info(`${lookups.filter((item) => item.dispatchNo).length} 張讀到案號，合併成 ${groups.size} 件案子`);

  const inspectAborted = lookupAborted ? true : await runStage({
    label: '統整案件內的紀錄表',
    page: session.page,
    keys: [...groups.keys()],
    done: progress.inspections,
    describe: (dispatchNo) => `派遣案號 ${maskCode(dispatchNo)}（未結案 ${groups.get(dispatchNo).temsisList.length} 張）`,
    run: (dispatchNo) => readCaseStatuses(session.context, session.page, dispatchNo, range),
    onFailure: (dispatchNo, reason) => ({ dispatchNo, rows: [], buttonCount: 0, caseListRows: 0, error: reason }),
    isFailure: (item) => Boolean(item.error),
    save,
  });

  const summaries = [...groups.entries()].map(([dispatchNo, group]) => buildCaseSummary(
    progress.inspections.get(dispatchNo)
      ?? { dispatchNo, rows: [], buttonCount: 0, caseListRows: 0, error: '這次沒有跑到（中途停止）' },
    group,
  ));
  return { recordCount: records.length, lookups, summaries, aborted: inspectAborted, skipped };
}
