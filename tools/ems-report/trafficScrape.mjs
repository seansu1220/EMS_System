/**
 * 二級以上因交通事故救護案件——查詢與匯出。
 *
 * 條件依使用者 2026-09-01 說明的人工作業：
 *   救護狀態＝已結案、危急個案、受傷機轉＝因交通事故，
 *   到院後檢傷分級分別選第 1 級與第 2 級各查一次、各匯出一份。
 *
 * ⚠ 這一頁有兩組長得一模一樣的欄位（受傷機轉的 `_scar` 與 `_scarSub`；
 *   到院前／到院後檢傷分級兩個下拉的選項也完全相同），選錯了畫面不會有任何反應，
 *   只會安靜地產出一份條件不對的名單。因此每匯出一份就**逐列回頭核對**，
 *   對不上就換另一個候選重來一次，兩個都不對就停手（不用猜的）。
 *
 * ⚠ 匯出檔含個案明細（姓名、身分證字號），只落在本機 out/raw/，用完即刪。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE, PATHS, QUERY_CRITERIA, TRAFFIC_CASE_REPORT } from './config.mjs';
import { formatDateForSite } from './dateRange.mjs';
import { log } from './logger.mjs';
import {
  fillField as fillFrameField,
  selectField as selectFrameField,
  setCheckbox as setFrameCheckbox,
  detectDateFormat as detectFrameDateFormat,
} from './formFill.mjs';
import { getFrame, gotoRecordQuery, ensureFieldVisible } from './navigation.mjs';
import { findCheckbox } from './pageFinder.mjs';
import { runQuery, exportExcelWithRetry } from './scrape.mjs';
import { readSheetTable } from './workbook.mjs';
import { verifyExportRows } from './trafficCases.mjs';

/**
 * @typedef {Object} LevelExport 一個檢傷等級的查詢結果
 * @property {string} levelLabel 檢傷等級（第1級／第2級）
 * @property {string|null} filePath 匯出檔位置；查無案件時為 null
 * @property {Record<string, string>[]} mainRows 詳細報表一
 * @property {Record<string, string>[]} patientRows 詳細報表二
 * @property {string[]} warnings 核對到、但不足以中止的情況（見 config 的 severity）
 */

/** 內容框每次導航都會重建，一律重新取得，不可快取。 */
const content = (page) => getFrame(page, SITE.frames.content);

/** 依標籤文字找勾選框；找不到就退回設定裡的 id 候選（見 config 的說明）。 */
async function resolveCheckbox(page, labelText, fallbackSelectors) {
  const match = await findCheckbox(content(page), [labelText]).catch(() => null);
  if (match?.selector) {
    log.info(`「${labelText}」勾選欄：${match.selector}（${match.matchedBy}）`);
    return match.selector;
  }
  log.info(`「${labelText}」找不到對應標籤，改用設定的欄位 ${fallbackSelectors[0]}`);
  return fallbackSelectors[0];
}

/**
 * 勾一個勾選框：先試著把它所在的區塊展開，展不開也照樣寫入值。
 *
 * 展不開不算失敗——`setCheckbox` 對看不見的欄位是直接寫 `checked` 再補送事件，
 * 而且會回讀確認。2026-09-01 第一次實跑就是卡在這裡：欄位其實勾得到，
 * 卻因為「展開後仍看不見」而整支停掉。
 */
async function checkCriterion(page, selector, label) {
  try {
    await ensureFieldVisible(page, selector);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.info(`${label} 沒辦法讓它顯示出來（${reason}），改為直接寫入並回讀確認`);
  }
  await setFrameCheckbox(content(page), selector, true, label);
}

/**
 * 設定所有等級共用的條件：期間、救護狀態、危急個案、受傷機轉＝因交通事故。
 *
 * @param {import('playwright-core').Page} page
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {string} dateFormat
 * @param {string} trafficSelector 受傷機轉「因交通事故」的勾選欄
 * @param {string} criticalSelector 「危急個案」的勾選欄
 */
async function applyCommonCriteria(page, monthRange, dateFormat, trafficSelector, criticalSelector) {
  log.step('設定查詢條件');
  // 迄日用 23:59:59，否則格式含時間時會變成當天 00:00:00，漏掉整個最後一天的案件。
  await fillFrameField(content(page), SITE.queryFields.dateFrom,
    formatDateForSite(monthRange.start, dateFormat), '起日');
  await fillFrameField(content(page), SITE.queryFields.dateTo,
    formatDateForSite(monthRange.end, dateFormat, { endOfDay: true }), '迄日');

  await ensureFieldVisible(page, SITE.queryFields.rescueStatus);
  await selectFrameField(content(page), SITE.queryFields.rescueStatus,
    QUERY_CRITERIA.rescueStatusValue, `救護狀態＝${QUERY_CRITERIA.rescueStatusLabel}`);

  await checkCriterion(page, criticalSelector, '危急個案');
  await checkCriterion(page, trafficSelector, '受傷機轉＝因交通事故');
}

/**
 * 找出「到院後檢傷分級」是哪一個下拉。
 *
 * 兩個下拉的選項一模一樣（未評／第1級…第5級），只能靠畫面上的標籤分辨：
 * 先看同一格與同一列的文字有沒有「到院後」，只有一個候選命中才算數。
 * 判不出來不算失敗——回傳第一個候選，後面會用匯出檔逐列核對，錯了再換。
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<string>} 選中的下拉選擇器
 */
async function resolveTriageSelect(page) {
  const candidates = SITE.queryFields.triageAfterArrivalCandidates;
  const matched = [];
  for (const selector of candidates) {
    const nearbyText = await content(page)
      .locator(selector)
      .evaluate((element) => {
        const cell = element.closest('td, th');
        const previous = cell?.previousElementSibling;
        const row = element.closest('tr');
        return [previous?.textContent, cell?.textContent, row?.textContent]
          .map((text) => (text || '').replace(/\s+/g, ''))
          .join(' | ');
      })
      .catch(() => '');
    if (/到院後/.test(nearbyText) && !/到院前/.test(nearbyText)) matched.push(selector);
  }

  if (matched.length === 1) {
    log.info(`到院後檢傷分級：${matched[0]}（畫面標籤含「到院後」）`);
    return matched[0];
  }
  log.info(
    `到院後檢傷分級的兩個候選都分不出來（標籤同時含到院前與到院後，或都找不到），` +
      `先用 ${candidates[0]}，匯出後會逐列核對，不對再換。`,
  );
  return candidates[0];
}

/** 查詢結果是不是「查無資料」。是的話不必按匯出（按了只會拿到空檔或錯誤）。 */
async function hasNoResult(page) {
  const marker = content(page).getByText(SITE.noResultMarker, { exact: false }).first();
  return (await marker.count().catch(() => 0)) > 0;
}

/** 讀回匯出檔的兩張工作表（含個資，只留在記憶體）。 */
function readExportSheets(filePath) {
  const { joinKeyColumn, sheets } = TRAFFIC_CASE_REPORT;
  const main = readSheetTable(filePath, sheets.main, [joinKeyColumn]);
  const patient = readSheetTable(filePath, sheets.patient, [joinKeyColumn]);
  return { mainRows: main.rows, patientRows: patient.rows };
}

/**
 * 產生「這一份匯出檔應該長什麼樣」的核對條件。
 * @param {string} levelLabel
 */
function expectationsFor(levelLabel) {
  const { triage, traffic, critical } = TRAFFIC_CASE_REPORT.verifyColumns;
  return [{ ...triage, expected: levelLabel }, traffic, critical];
}

/**
 * 查詢並匯出一個檢傷等級，匯出後逐列核對條件。
 *
 * @returns {Promise<{levelExport: LevelExport|null, failed: {key: string, label: string, badCount: number}[]}>}
 *   核對不過時 `levelExport` 為 null，由呼叫端決定換哪個候選重來
 */
async function queryAndExportLevel(context, page, monthRange, level, triageSelector) {
  // 展不開也照樣選：`selectField` 會直接寫入並回讀確認（同 checkCriterion 的理由）。
  await ensureFieldVisible(page, triageSelector).catch((error) => {
    log.info(`檢傷分級下拉沒辦法讓它顯示出來（${error.message}），改為直接寫入並回讀確認`);
  });
  await selectFrameField(content(page), triageSelector, level.value, `到院後檢傷分級＝${level.label}`);

  log.info('按下查詢，等待結果');
  await runQuery(page);
  if (await hasNoResult(page)) {
    log.warn(`${level.label}：這個月沒有任何符合條件的案件`);
    return {
      levelExport: { levelLabel: level.label, filePath: null, mainRows: [], patientRows: [], warnings: [] },
      failed: [],
    };
  }

  log.info('按下匯出EXCEL，等待下載');
  const filePath = path.join(PATHS.rawDir, `${monthRange.label}-traffic-${level.key}.xls`);
  await exportExcelWithRetry(context, page, filePath);

  const { mainRows, patientRows } = readExportSheets(filePath);
  log.info(`${level.label}：匯出 ${mainRows.length} 件`);

  const failed = verifyExportRows(mainRows, expectationsFor(level.label));
  for (const item of failed) {
    log.warn(`${level.label}：有 ${item.badCount} 件的「${item.label}」對不上（欄位 ${item.column}）`);
  }
  // 只有「畫面上有兩個長得一樣的欄位」那兩項才需要換候選重來（見 config 的 severity 說明）。
  const mustStop = failed.filter((item) => item.severity !== 'warn');
  if (mustStop.length > 0) return { levelExport: null, failed: mustStop };

  const warnings = failed.map(
    (item) => `${level.label}：${item.badCount} 件在匯出檔裡沒有「${item.label}」，請自行確認要不要留`,
  );
  log.ok(`${level.label}：${mainRows.length} 件，條件逐列核對通過`);
  return { levelExport: { levelLabel: level.label, filePath, mainRows, patientRows, warnings }, failed: [] };
}

/**
 * 依序查詢每個檢傷等級並匯出。
 *
 * 核對不過時換另一個候選欄位重來一次（受傷機轉與檢傷分級各有兩個長得一樣的欄位），
 * 都換過還是不對就中止——寧可沒有產出，也不要交出一份條件不對的公文。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<LevelExport[]>}
 */
export async function exportTrafficCaseDatasets(context, page, monthRange) {
  await fs.mkdir(PATHS.rawDir, { recursive: true });

  log.step('開啟救護紀錄表查詢');
  const route = await gotoRecordQuery(page);
  log.ok(`已開啟（${route}）`);

  const dateFormat = await detectFrameDateFormat(
    content(page), SITE.queryFields.dateFrom, SITE.defaultDateFormat,
  );

  const criticalSelector = await resolveCheckbox(page, '危急個案', [SITE.queryFields.criticalCase]);
  const trafficCandidates = [...SITE.queryFields.injuryByTrafficCandidates];
  const preferred = await resolveCheckbox(page, '因交通事故', trafficCandidates);
  // 標籤找出來的那個排最前面，其餘保留為候選（順序去重）。
  const trafficQueue = [preferred, ...trafficCandidates.filter((item) => item !== preferred)];
  const triageQueue = [...SITE.queryFields.triageAfterArrivalCandidates];
  let trafficSelector = trafficQueue.shift();
  let triageSelector = await resolveTriageSelect(page);
  const remainingTriage = triageQueue.filter((item) => item !== triageSelector);

  await applyCommonCriteria(page, monthRange, dateFormat, trafficSelector, criticalSelector);

  /** @type {LevelExport[]} */
  const exports = [];
  for (const level of TRAFFIC_CASE_REPORT.triageLevels) {
    log.step(`查詢並匯出：到院後檢傷分級＝${level.label}`);
    let attempt = await queryAndExportLevel(context, page, monthRange, level, triageSelector);

    while (attempt.levelExport === null) {
      const wrongTriage = attempt.failed.some((item) => item.key === 'triage');
      const wrongTraffic = attempt.failed.some((item) => item.key === 'traffic');

      if (wrongTriage && remainingTriage.length > 0) {
        triageSelector = remainingTriage.shift();
        log.warn(`改用另一個檢傷分級下拉 ${triageSelector} 重來一次`);
      } else if (wrongTraffic && trafficQueue.length > 0) {
        await setFrameCheckbox(content(page), trafficSelector, false, '取消原本的受傷機轉勾選');
        trafficSelector = trafficQueue.shift();
        log.warn(`改用另一個受傷機轉勾選欄 ${trafficSelector} 重來一次`);
        await checkCriterion(page, trafficSelector, '受傷機轉＝因交通事故');
      } else {
        throw new Error(
          `匯出結果與查詢條件對不上，已無其他欄位可換，不產出報表：` +
            attempt.failed.map((item) => `${item.label}（${item.badCount} 件不符）`).join('、'),
        );
      }
      attempt = await queryAndExportLevel(context, page, monthRange, level, triageSelector);
    }
    exports.push(attempt.levelExport);
  }
  return exports;
}
