/**
 * 查詢與匯出：在救護紀錄表查詢頁設定條件，查詢後匯出 Excel。
 *
 * 共匯出兩份：
 *   1. 救護狀態＝已結案（總案件數）
 *   2. 救護狀態＝已結案 ＋ 院前預警＝到院前傳送預警（預警案件數）
 *
 * ⚠ 匯出檔含個案明細，只落在本機 out/raw/，且預設統計後即刪除。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE, PATHS, QUERY_CRITERIA, DATASETS, DOWNLOAD_TIMEOUT_MS } from './config.mjs';
import { formatDateForSite } from './dateRange.mjs';
import { log } from './logger.mjs';
import {
  fillField as fillFrameField,
  selectField as selectFrameField,
  detectDateFormat as detectFrameDateFormat,
} from './formFill.mjs';
import { getFrame, gotoRecordQuery, ensureFieldVisible } from './navigation.mjs';

/**
 * 讀取查詢頁的日期格式（實作見 formFill.mjs，解鎖流程共用同一套）。
 * @returns {Promise<string>} 例如 `yyyy-MM-dd`
 */
async function detectDateFormat(page) {
  const content = getFrame(page, SITE.frames.content);
  return detectFrameDateFormat(content, SITE.queryFields.dateFrom, SITE.defaultDateFormat);
}

/**
 * 在內容框填入一個欄位的值（填完會回讀驗證，見 formFill.mjs）。
 * 這裡只負責「每次都重新取得內容框」——frame 每次導航都會重建，不可快取。
 */
async function fillField(page, selector, value, label) {
  return fillFrameField(getFrame(page, SITE.frames.content), selector, value, label);
}

/** 在內容框選擇一個下拉選項（以 value 指定，避免文字有全半形差異）。 */
async function selectField(page, selector, value, label) {
  return selectFrameField(getFrame(page, SITE.frames.content), selector, value, label);
}

/**
 * 設定兩次查詢共通的條件：期間、救護狀態、送醫情形。
 *
 * 送醫情形必須限定為「送醫」：未運送案件（誤報、拒送、現場死亡等）不會有到院前預警，
 * 若一併算進母數會讓比率被稀釋而失真。
 *
 * @param {import('playwright-core').Page} page
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {string} dateFormat
 */
async function applyCommonCriteria(page, monthRange, dateFormat) {
  log.step('設定查詢條件');
  // 迄日用 23:59:59，否則格式含時間時會變成當天 00:00:00，漏掉整個最後一天的案件。
  await fillField(page, SITE.queryFields.dateFrom, formatDateForSite(monthRange.start, dateFormat), '起日');
  await fillField(page, SITE.queryFields.dateTo, formatDateForSite(monthRange.end, dateFormat, { endOfDay: true }), '迄日');
  await ensureFieldVisible(page, SITE.queryFields.rescueStatus);
  await selectField(
    page,
    SITE.queryFields.rescueStatus,
    QUERY_CRITERIA.rescueStatusValue,
    `救護狀態＝${QUERY_CRITERIA.rescueStatusLabel}`,
  );

  await ensureFieldVisible(page, SITE.queryFields.transport);
  await selectField(
    page,
    SITE.queryFields.transport,
    QUERY_CRITERIA.transportValue,
    `送醫情形＝${QUERY_CRITERIA.transportLabel}`,
  );
}

/**
 * 等待任一視窗觸發檔案下載。
 *
 * 匯出可能由主視窗直接下載，也可能先開彈出視窗再下載，
 * 因此新開的分頁也要一併監聽，否則會漏接。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {() => Promise<void>} action 觸發下載的動作
 * @returns {Promise<import('playwright-core').Download>}
 */
function waitForAnyDownload(context, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待匯出檔案超過 ${DOWNLOAD_TIMEOUT_MS / 1000} 秒仍未開始下載`));
    }, DOWNLOAD_TIMEOUT_MS);

    const onDownload = (download) => {
      cleanup();
      resolve(download);
    };
    const onPage = (newPage) => newPage.on('download', onDownload);

    function cleanup() {
      clearTimeout(timer);
      context.off('page', onPage);
      for (const openPage of context.pages()) openPage.off('download', onDownload);
    }

    for (const openPage of context.pages()) openPage.on('download', onDownload);
    context.on('page', onPage);

    action().catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

/** 按下查詢並等待結果頁回來。 */
async function runQuery(page) {
  const content = getFrame(page, SITE.frames.content);
  await content.locator(SITE.queryFields.queryButton).click();
  // 這個系統以 POST 重載內容框，網址不會變，因此以「載入完成 + 緩衝」判定。
  await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(SITE.querySettleMs);
}

/**
 * 監看頁面是否出現系統自己的錯誤訊息（例如 `Error!!! wap119.RPS64101030_1._btnExcel()`）。
 *
 * 匯出在伺服器端失敗時**不會有任何下載**，若只等下載事件會白等到逾時（3 分鐘）才報錯。
 * 這裡改為一偵測到錯誤字樣就立刻中止。
 *
 * ⚠ 只取出錯誤訊息那一行，不讀取也不記錄頁面上的查詢結果內容。
 *
 * @param {{stopped: boolean}} stopSignal 下載成功後用來停止監看
 */
function watchForSiteError(page, stopSignal) {
  return new Promise((_resolve, reject) => {
    const timer = setInterval(async () => {
      if (stopSignal.stopped) {
        clearInterval(timer);
        return;
      }
      try {
        const content = page.frames().find((frame) => frame.name() === SITE.frames.content);
        if (!content) return;
        const errorText = content.getByText(SITE.errorMarker, { exact: false }).first();
        if ((await errorText.count()) === 0) return;
        clearInterval(timer);
        const message = ((await errorText.innerText().catch(() => '')) || SITE.errorMarker)
          .split('\n')[0]
          .trim()
          .slice(0, 150);
        reject(new Error(`系統回報匯出失敗：${message}`));
      } catch {
        // 頁面正在換頁時查詢元素會失敗，忽略後續輪詢即可。
      }
    }, 2000);
  });
}

/** 按下匯出 EXCEL 並把檔案存到指定路徑。 */
async function exportExcel(context, page, targetPath) {
  const stopSignal = { stopped: false };
  const downloadPromise = waitForAnyDownload(context, async () => {
    const content = getFrame(page, SITE.frames.content);
    await content.locator(SITE.queryFields.excelButton).click();
  });

  let download;
  try {
    download = await Promise.race([downloadPromise, watchForSiteError(page, stopSignal)]);
  } finally {
    stopSignal.stopped = true;
  }
  await download.saveAs(targetPath);
  const suggested = download.suggestedFilename();
  log.ok(`已下載：${path.basename(targetPath)}（系統原檔名 ${suggested}）`);
  return targetPath;
}

/**
 * 匯出失敗時重新查詢並再試一次。
 *
 * 這個系統的匯出偶爾會在伺服器端拋例外（`Error!!! ..._btnExcel()`）。
 * 由於失敗現在能在數秒內偵測到，重試的成本很低，
 * 但可以省下使用者為了重跑而重新登入一次的麻煩。
 */
async function exportExcelWithRetry(context, page, targetPath) {
  try {
    return await exportExcel(context, page, targetPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`匯出失敗（${reason}）`);
    log.info('重新查詢後再試一次');
    await runQuery(page);
    return exportExcel(context, page, targetPath);
  }
}

/**
 * 執行兩次查詢與匯出。
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<{total: string, alert: string}>} 兩份原始檔的路徑
 */
export async function exportBothDatasets(context, page, monthRange) {
  await fs.mkdir(PATHS.rawDir, { recursive: true });

  log.step('開啟救護紀錄表查詢');
  const route = await gotoRecordQuery(page);
  log.ok(`已開啟（${route}）`);

  const dateFormat = await detectDateFormat(page);
  await applyCommonCriteria(page, monthRange, dateFormat);

  const results = {};
  for (const dataset of [DATASETS.total, DATASETS.alert]) {
    log.step(`查詢並匯出：${dataset.label}`);
    await ensureFieldVisible(page, SITE.queryFields.prehospitalAlert);
    await selectField(
      page,
      SITE.queryFields.prehospitalAlert,
      dataset.alertValue,
      dataset.alertValue
        ? `院前預警＝${QUERY_CRITERIA.prehospitalAlertLabel}`
        : '院前預警＝不限（取得全部送醫案件）',
    );

    log.info('按下查詢，等待結果');
    await runQuery(page);
    log.info('按下匯出EXCEL，等待下載');
    const targetPath = path.join(PATHS.rawDir, `${monthRange.label}-${dataset.key}.xls`);
    results[dataset.key] = await exportExcelWithRetry(context, page, targetPath);
  }
  return results;
}
