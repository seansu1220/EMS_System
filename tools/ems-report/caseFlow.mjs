/**
 * 案件層級的共用頁面操作（解鎖流程與心電圖逐案查核共用）。
 *
 * 這些步驟兩個流程完全一樣：填查詢期間、依標籤填條件、按查詢、
 * 以派遣案號進入案件內部、判斷「現在是不是還在案件內部」。
 * 原本住在 `unlock.mjs`，因心電圖查核也要走同一條路而抽出來——
 * 複製一份的話，日後系統改版就得改兩處，改一處漏一處的風險比重構高。
 *
 * ⚠ 個資原則：可識別個案的編號（TEMSIS、派遣案號）一律以 `maskCode` 只顯示末 4 碼，
 *   連填入失敗的錯誤訊息也不印原值（`fillField` 的 `displayValue`）。
 */
import { SITE, UNLOCK } from './config.mjs';
import { formatDateForSite } from './dateRange.mjs';
import { fillField, detectDateFormat } from './formFill.mjs';
import { log } from './logger.mjs';
import { getFrame, gotoMenuItem } from './navigation.mjs';
import {
  findField,
  findClickables,
  clickMatch,
  listFields,
  listClickableTexts,
  groupByRow,
} from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import { maskCode } from './sheetFields.mjs';

/** 取得目前的內容框（每次動作都會重載，不可快取）。 */
export function content(page) {
  return getFrame(page, SITE.frames.content);
}

/**
 * 找出這一頁的起訖日期欄位。
 *
 * 先試統計流程已驗證過的 id；不同功能頁若換了 id，再以 My97DatePicker 的特徵
 * （欄位的 onfocus/onclick 會呼叫 WdatePicker）找出所有日期欄，取前兩個當起訖。
 *
 * @returns {Promise<{from: string, to: string}>}
 */
async function findDateFields(page) {
  const frame = content(page);
  const knownFrom = await frame.locator(SITE.queryFields.dateFrom).count().catch(() => 0);
  const knownTo = await frame.locator(SITE.queryFields.dateTo).count().catch(() => 0);
  if (knownFrom > 0 && knownTo > 0) {
    return { from: SITE.queryFields.dateFrom, to: SITE.queryFields.dateTo };
  }

  const detected = await frame.evaluate(() =>
    [...document.querySelectorAll('input')]
      .filter((element) => {
        const attributes = ['onfocus', 'onclick', 'onchange', 'class']
          .map((name) => element.getAttribute(name) || '')
          .join(' ');
        return /WdatePicker|Wdate/i.test(attributes);
      })
      .map((element) => (element.id ? `#${element.id}` : ''))
      .filter(Boolean),
  );
  if (detected.length >= 2) {
    log.info(`日期欄位以日曆元件特徵找到：${detected[0]}、${detected[1]}`);
    return { from: detected[0], to: detected[1] };
  }
  throw new Error(
    `這一頁找不到起訖日期欄位（既沒有 ${SITE.queryFields.dateFrom}，也找不到日曆元件）`,
  );
}

/**
 * 設定查詢期間。
 * @param {import('./dateRange.mjs').MonthRange} range
 */
export async function applyDateRange(page, range) {
  const fields = await findDateFields(page);
  const dateFormat = await detectDateFormat(content(page), fields.from, SITE.defaultDateFormat);
  await fillField(content(page), fields.from, formatDateForSite(range.start, dateFormat), '起日');
  await fillField(
    content(page),
    fields.to,
    // 迄日必須是 23:59:59，否則格式含時間時會變成當天 00:00:00，漏掉整個最後一天。
    formatDateForSite(range.end, dateFormat, { endOfDay: true }),
    '迄日',
  );
}

/**
 * 依標籤文字找到欄位並填值；找不到欄位時，把這一頁實際有的欄位列進錯誤訊息。
 * @param {string[]} labelCandidates
 */
export async function applyTextCondition(page, labelCandidates, value, fieldName) {
  const field = await findField(content(page), labelCandidates);
  if (!field) {
    const available = await listFields(content(page));
    const summary = available
      .map((item) => `${item.nearbyText || '(無標籤)'}→${item.selector}`)
      .join('｜');
    throw new Error(
      `找不到「${fieldName}」欄位（試過的標籤：${labelCandidates.join('、')}）。`
        + `這一頁的輸入欄有：${summary || '(一個都沒有)'}`,
    );
  }
  log.info(`${fieldName} 欄位＝${field.selector}（靠標籤「${field.labelText}」的${field.matchedBy}找到）`);
  // TEMSIS 與派遣案號可識別個案，畫面與紀錄檔一律只顯示末 4 碼。
  await fillField(content(page), field.selector, value, fieldName, {
    displayValue: maskCode(value),
  });
}

/**
 * 找可點元素；一個都沒有時多等一輪再找一次。
 *
 * 查詢結果是非同步回填的，第一次找不到未必代表真的沒有——
 * 直接判定「查無案件」會冤枉掉存在的案件，多等一次的成本則很低。
 */
export async function findClickablesWithRetry(page, textCandidates, options = {}) {
  const found = await findClickables(content(page), textCandidates, options);
  if (found.length > 0) return found;
  await page.waitForTimeout(UNLOCK.settleMs);
  return findClickables(content(page), textCandidates, options);
}

/**
 * 產生「這一頁有哪些可以點的東西」的說明，附在找不到目標時的錯誤訊息裡。
 * 內容只有按鈕文字（數字已遮蔽），不含任何欄位值。
 */
export async function describeClickableOptions(page) {
  const texts = await listClickableTexts(content(page)).catch(() => []);
  return texts.length > 0 ? `這一頁可以點的有：${texts.join('｜')}` : '這一頁沒有任何可點的元素';
}

/** 按下查詢並等待結果。查詢鈕優先用已知 id，找不到才以文字定位。 */
export async function submitQuery(page) {
  const frame = content(page);
  const hasKnownButton = await frame.locator(SITE.queryFields.queryButton).count().catch(() => 0);
  if (hasKnownButton > 0) {
    await frame.locator(SITE.queryFields.queryButton).click();
  } else if (!(await clickMatch(frame, ['查詢'], 0, { exact: true }))) {
    throw new Error('找不到查詢按鈕（既沒有 #_btnQuery，也沒有文字為「查詢」的按鈕）');
  }
  // 系統以 POST 重載內容框，網址不會變，因此以「載入完成 ＋ 緩衝」判定。
  await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(UNLOCK.settleMs);
}

/**
 * 依候選欄名的順序，取第一個有值的欄位。
 * @param {{values?: Record<string,string>}|null} row
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function pickFirstValue(row, candidates) {
  for (const name of candidates) {
    const value = row?.values?.[name];
    if (value) return value;
  }
  return null;
}

/**
 * 現在這一刻畫面是不是還在案件內部（只看一次，不等待）。
 *
 * ⚠ 只回傳布林值，不把頁面內容帶出來。
 *
 * @returns {Promise<boolean>}
 */
export async function hasCaseDetail(page) {
  return content(page)
    .evaluate(
      (markers) => {
        const text = document.body?.innerText ?? '';
        return markers.some((marker) => text.includes(marker));
      },
      UNLOCK.caseDetailMarkers,
    )
    .catch(() => false);
}

/**
 * 等待畫面真的變成「案件內部」。
 *
 * 以畫面上出現特定字樣為準，而不是等固定秒數：頁面切換的快慢會隨網路與資料量變動，
 * 用時間猜必然有時對有時錯。
 *
 * @returns {Promise<boolean>}
 */
export async function waitForCaseDetail(page) {
  const deadline = Date.now() + UNLOCK.caseDetailTimeoutMs;
  while (Date.now() < deadline) {
    if (await hasCaseDetail(page)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** 以指派案號在案件列表找到案件並進入內部。 */
export async function openCaseByDispatchNo(context, page, dispatchNo, range) {
  log.step(`案件列表查詢（派遣案號 ${maskCode(dispatchNo)}）`);
  await gotoMenuItem(page, UNLOCK.caseListMenuText);
  await captureSnapshot(context, '解鎖-案件列表');
  await applyDateRange(page, range);
  await applyTextCondition(page, UNLOCK.fieldLabels.dispatchNo, dispatchNo, '派遣案號');
  await submitQuery(page);

  // 用完全相同比對：「救護紀錄」若用包含比對，會連「救護紀錄PDF」一起命中。
  const links = await findClickablesWithRetry(page, UNLOCK.buttonTexts.openCase, { exact: true });
  const rows = groupByRow(links);
  if (rows.length === 0) {
    await captureSnapshot(context, '解鎖-案件列表無結果');
    throw new Error(
      `案件列表查不到這個派遣案號（或「${UNLOCK.buttonTexts.openCase[0]}」連結的文字已改變）。`
        + await describeClickableOptions(page),
    );
  }
  if (rows.length > 1) {
    log.warn(`案件列表查到 ${rows.length} 筆，取第一筆進入；請自行確認是否合理`);
  }
  // 點完之後**必須確認真的換頁了**才能往下做。
  // 只固定等幾秒的話，頁面還沒切換時會把案件列表誤當成案件內部，
  // 於是回報「找不到解鎖按鈕」——實跑時三筆有兩筆栽在這裡。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const clicked = await clickMatch(
      content(page),
      UNLOCK.buttonTexts.openCase,
      rows[0][0].index,
      { exact: true },
    );
    if (!clicked) throw new Error('點不開案件（「救護紀錄」連結在點擊當下消失了）');

    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    if (await waitForCaseDetail(page)) {
      await captureSnapshot(context, '解鎖-案件內部');
      return;
    }
    log.warn(`點了「${UNLOCK.buttonTexts.openCase[0]}」但還沒進入案件內部（第 ${attempt} 次）`);
  }

  await captureSnapshot(context, '解鎖-進不了案件內部');
  throw new Error(
    `點了「${UNLOCK.buttonTexts.openCase[0]}」兩次，`
      + `${UNLOCK.caseDetailTimeoutMs / 1000} 秒內都沒有出現案件內部的畫面`
      + `（判斷依據：出現「${UNLOCK.caseDetailMarkers.join('」「')}」任一個）。`
      + await describeClickableOptions(page),
  );
}
