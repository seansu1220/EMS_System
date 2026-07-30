/**
 * 解鎖救護紀錄表：把指定 TEMSIS 的案件由「已結案」調整為「未結案」。
 *
 * 流程（依使用者實際的操作步驟）：
 *   1. 報表系統 → 救護紀錄表查詢，期間設為近兩個月，填入 TEMSIS 查詢
 *   2. 開啟該筆的救護紀錄表，讀出「救災救護指揮中心指派案號」
 *   3. 報表系統 → 案件列表，期間同樣近兩個月，以指派案號查詢
 *   4. 點「救護紀錄」進入案件內部
 *   5. 只有一張紀錄表 → 那張就是目標
 *      有多張 → 逐張開啟比對 TEMSIS，只有相符的那張才是目標
 *
 * ⚠ 安全設計：**本版只做到「找出目標」為止，絕不按下「調整為未結案」**。
 *   解鎖是不可復原的寫入動作，等使用者用試跑結果確認比對邏輯無誤後才會開放。
 *
 * ⚠ 個資原則：紀錄表全文只存在記憶體，用完即棄；畫面與紀錄檔一律只顯示遮蔽後的編號末 4 碼。
 */
import { SITE, UNLOCK } from './config.mjs';
import { formatDateForSite } from './dateRange.mjs';
import { fillField, detectDateFormat } from './formFill.mjs';
import { log, prompt } from './logger.mjs';
import { getFrame, gotoRecordQuery, gotoMenuItem } from './navigation.mjs';
import {
  findField,
  findClickables,
  clickMatch,
  findPairedRows,
  listFields,
  listClickableTexts,
  groupByRow,
} from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import { extractLabeledCode, isSameCode, maskCode } from './sheetFields.mjs';

/**
 * @typedef {Object} UnlockOutcome
 * @property {string} temsis 使用者輸入的 TEMSIS（顯示時會遮蔽）
 * @property {'已定位'|'查無案件'|'需人工處理'|'失敗'} status
 * @property {string} detail 給人看的說明
 */

/** 取得目前的內容框（每次動作都會重載，不可快取）。 */
function content(page) {
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
async function applyDateRange(page, range) {
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
async function applyTextCondition(page, labelCandidates, value, fieldName) {
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
 * 產生「這一頁有哪些可以點的東西」的說明，附在找不到目標時的錯誤訊息裡。
 * 內容只有按鈕文字（數字已遮蔽），不含任何欄位值。
 */
async function describeClickableOptions(page) {
  const texts = await listClickableTexts(content(page)).catch(() => []);
  return texts.length > 0 ? `這一頁可以點的有：${texts.join('｜')}` : '這一頁沒有任何可點的元素';
}

/** 按下查詢並等待結果。查詢鈕優先用已知 id，找不到才以文字定位。 */
async function submitQuery(page) {
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
 * 開啟一張救護紀錄表，讀出指派案號與 TEMSIS。
 *
 * @param {number} index 第幾個「救護紀錄PDF」按鈕
 * @param {{exact?: boolean}} [options] 文字比對方式，**必須與算出 index 時相同**
 * @returns {Promise<{dispatchNo: string|null, temsis: string|null, kind: string}>}
 */
async function readSheetCodes(context, page, buttonTexts, index, options = {}) {
  const sheet = await openRecordSheet(context, content(page), buttonTexts, index, options);
  const dispatchNo = extractLabeledCode(sheet.text, UNLOCK.sheetLabels.dispatchNo);
  const temsis = extractLabeledCode(sheet.text, UNLOCK.sheetLabels.temsis);
  log.info(`紀錄表已讀取（${sheet.kind}／${sheet.source}），共 ${sheet.text.length} 個字元`);
  return {
    dispatchNo: dispatchNo?.value ?? null,
    temsis: temsis?.value ?? null,
    kind: sheet.kind,
  };
}

/**
 * 步驟 1~2：以 TEMSIS 查到案件，開紀錄表取得指派案號。
 * @returns {Promise<{dispatchNo: string, sheetTemsis: string|null}>}
 */
async function findDispatchNoByTemsis(context, page, temsis, range) {
  log.step(`查詢救護紀錄表（TEMSIS ${maskCode(temsis)}）`);
  await gotoRecordQuery(page);
  await applyDateRange(page, range);
  await applyTextCondition(page, UNLOCK.fieldLabels.temsis, temsis, 'TEMSIS');
  await submitQuery(page);

  const buttons = await findClickables(content(page), UNLOCK.buttonTexts.openRecordSheet);
  const rows = groupByRow(buttons);
  if (rows.length === 0) {
    await captureSnapshot(context, '解鎖-救護紀錄表查詢無結果');
    throw new Error(
      '查無案件：這個 TEMSIS 在查詢期間內沒有結果，或紀錄表按鈕的文字已改變。'
        + await describeClickableOptions(page),
    );
  }
  if (rows.length > 1) {
    log.warn(`這個 TEMSIS 查到 ${rows.length} 筆案件，取第一筆處理；請自行確認是否合理`);
  }

  const codes = await readSheetCodes(context, page, UNLOCK.buttonTexts.openRecordSheet, rows[0][0].index);
  if (!codes.dispatchNo) {
    await captureSnapshot(context, '解鎖-紀錄表讀不到指派案號');
    throw new Error(
      `紀錄表讀得到內容，但找不到「${UNLOCK.sheetLabels.dispatchNo[0]}」欄位（格式：${codes.kind}）`,
    );
  }
  // 紀錄表上讀不到 TEMSIS 的話，多張紀錄表時就無從比對，先示警讓使用者知道要調標籤。
  if (!codes.temsis) {
    log.warn(
      `紀錄表上找不到 TEMSIS 欄位（試過的標籤：${UNLOCK.sheetLabels.temsis.join('、')}）。`
        + '案件內若有多張紀錄表將無法比對，請回報以便調整標籤設定。',
    );
  }
  // 防呆：紀錄表上的 TEMSIS 應與輸入的一致，不一致代表查詢條件沒生效或點錯列。
  if (codes.temsis && !isSameCode(codes.temsis, temsis)) {
    throw new Error(
      `紀錄表上的 TEMSIS（${maskCode(codes.temsis)}）與輸入的（${maskCode(temsis)}）不符，已中止`,
    );
  }
  log.ok(`指派案號：${maskCode(codes.dispatchNo)}`);
  return { dispatchNo: codes.dispatchNo, sheetTemsis: codes.temsis };
}

/** 步驟 3~4：以指派案號在案件列表找到案件並進入內部。 */
async function openCaseByDispatchNo(context, page, dispatchNo, range) {
  log.step(`案件列表查詢（派遣案號 ${maskCode(dispatchNo)}）`);
  await gotoMenuItem(page, UNLOCK.caseListMenuText);
  await captureSnapshot(context, '解鎖-案件列表');
  await applyDateRange(page, range);
  await applyTextCondition(page, UNLOCK.fieldLabels.dispatchNo, dispatchNo, '派遣案號');
  await submitQuery(page);

  // 用完全相同比對：「救護紀錄」若用包含比對，會連「救護紀錄PDF」一起命中。
  const links = await findClickables(content(page), UNLOCK.buttonTexts.openCase, { exact: true });
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
  if (!(await clickMatch(content(page), UNLOCK.buttonTexts.openCase, rows[0][0].index, { exact: true }))) {
    throw new Error('點不開案件（「救護紀錄」連結在點擊當下消失了）');
  }
  await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(UNLOCK.settleMs);
  await captureSnapshot(context, '解鎖-案件內部');
}

/**
 * 步驟 5：在案件內部決定「該解哪一張紀錄表」。
 *
 * 只有一張時直接鎖定；多張時逐張開啟比對 TEMSIS，
 * **比對不到就回報需人工處理，絕不退而求其次挑一張**。
 *
 * @param {{readCodes?: typeof readSheetCodes}} [deps] 讀取紀錄表的方式（測試時可注入假的）
 * @returns {Promise<UnlockOutcome>}
 */
export async function locateUnlockTarget(context, page, temsis, deps = {}) {
  const readCodes = deps.readCodes ?? readSheetCodes;
  const paired = await findPairedRows(
    content(page),
    UNLOCK.buttonTexts.openRecordInCase,
    UNLOCK.buttonTexts.unlock,
    { recordExact: false },
  );
  log.info(
    `案件內部：紀錄表 ${paired.recordCount} 張、`
      + `「${UNLOCK.buttonTexts.unlock[0]}」按鈕 ${paired.unlockCount} 個`,
  );
  // 把配對結果攤開來，方便核對「第幾張紀錄表配到第幾個按鈕」是否合理（只有序號，沒有內容）。
  if (paired.pairs.length > 0) {
    const mapping = paired.pairs
      .map((pair) => `第${pair.recordIndex + 1}張→${pair.unlockIndex < 0 ? '同列無按鈕' : `第${pair.unlockIndex + 1}個按鈕`}`)
      .join('、');
    log.info(`  配對結果：${mapping}`);
  }

  if (paired.unlockCount === 0) {
    return {
      temsis,
      status: '需人工處理',
      detail: `案件內部找不到「${UNLOCK.buttonTexts.unlock[0]}」按鈕（可能已是未結案，或按鈕文字不同）`,
    };
  }
  if (paired.unlockCount === 1) {
    return { temsis, status: '已定位', detail: '案件內只有一張紀錄表，該張即為解鎖目標' };
  }
  if (paired.recordCount === 0) {
    // 有多個解鎖按鈕卻找不到可點開的紀錄表，就無從比對 TEMSIS，此時任何選擇都是猜的。
    return {
      temsis,
      status: '需人工處理',
      detail: `有 ${paired.unlockCount} 個解鎖按鈕，但找不到可點開的`
        + `「${UNLOCK.buttonTexts.openRecordInCase[0]}」，無法比對是哪一張。`
        + await describeClickableOptions(page),
    };
  }

  log.info(`有 ${paired.recordCount} 張紀錄表，逐張開啟比對 TEMSIS`);
  for (const pair of paired.pairs) {
    // 文字候選與 exact 都必須與上面 findPairedRows 完全一致，否則序號會對到別張紀錄表。
    const codes = await readCodes(
      context,
      page,
      UNLOCK.buttonTexts.openRecordInCase,
      pair.recordIndex,
      { exact: false },
    );
    if (!codes.temsis) {
      log.warn(`第 ${pair.recordIndex + 1} 張紀錄表讀不到 TEMSIS，跳過這張`);
      continue;
    }
    if (!isSameCode(codes.temsis, temsis)) continue;
    if (pair.unlockIndex < 0) {
      return {
        temsis,
        status: '需人工處理',
        detail: `第 ${pair.recordIndex + 1} 張紀錄表的 TEMSIS 相符，`
          + '但同一列裡沒有解鎖按鈕，無法確定該按哪一個（不猜，請人工處理）',
      };
    }
    return {
      temsis,
      status: '已定位',
      detail: `第 ${pair.recordIndex + 1} 張紀錄表的 TEMSIS 相符，`
        + `對應同一列的第 ${pair.unlockIndex + 1} 個解鎖按鈕`,
    };
  }
  return {
    temsis,
    status: '需人工處理',
    detail: `${paired.recordCount} 張紀錄表都沒有相符的 TEMSIS`,
  };
}

/**
 * 處理一筆 TEMSIS。
 * @returns {Promise<UnlockOutcome>}
 */
async function processTemsis(context, page, temsis, range) {
  try {
    const { dispatchNo } = await findDispatchNoByTemsis(context, page, temsis, range);
    await openCaseByDispatchNo(context, page, dispatchNo, range);
    const outcome = await locateUnlockTarget(context, page, temsis);
    log[outcome.status === '已定位' ? 'ok' : 'warn'](`${maskCode(temsis)}：${outcome.detail}`);
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.fail(`處理 TEMSIS ${maskCode(temsis)}`, error);
    return {
      temsis,
      status: reason.startsWith('查無案件') ? '查無案件' : '失敗',
      detail: reason,
    };
  }
}

/**
 * 在終端機請使用者貼上 TEMSIS。
 *
 * 一行一個，也接受一行貼多個（以空白或逗號分隔）；空白行代表輸入結束。
 * @returns {Promise<string[]>} 去除重複後的清單
 */
export async function promptTemsisList() {
  log.step('請貼上要解鎖的 TEMSIS 編號');
  log.info('一個一行：貼上一個就按 Enter，游標會跳到下一行等你貼下一個。');
  log.info('全部貼完後，在「空白的那一行」再按一次 Enter，才會開始執行。');
  log.info('（只有一筆的話就是：貼上 → Enter → 再按一次 Enter）');
  /** @type {string[]} */
  const collected = [];
  for (;;) {
    // 第一行特別附上說明，使用者才不會以為按了 Enter 就直接開跑。
    const hint = collected.length === 0 ? '（貼完按 Enter 換行，空白行開始執行）' : '';
    const line = await prompt(`  [${collected.length + 1}]${hint} `);
    // null 代表輸入串流結束（EOF），空字串代表使用者按了 Enter，兩者都視為輸入完畢。
    if (line === null || line === '') break;
    collected.push(...line.split(/[\s,，;；]+/).filter(Boolean));
  }
  return [...new Set(collected)];
}

/**
 * 解鎖流程主入口（本版為試跑：只定位目標，不按下解鎖）。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {{temsisList: string[], range: import('./dateRange.mjs').MonthRange}} options
 * @returns {Promise<UnlockOutcome[]>}
 */
export async function runUnlockFlow(session, options) {
  const { temsisList, range } = options;
  log.step(`試跑模式：只找出「該解哪一張」，不會按下「${UNLOCK.buttonTexts.unlock[0]}」`);
  log.info(`查詢期間：${range.start} ~ ${range.end}（${range.label}）`);
  log.info(`共 ${temsisList.length} 筆 TEMSIS 要處理`);

  /** @type {UnlockOutcome[]} */
  const outcomes = [];
  for (const [position, temsis] of temsisList.entries()) {
    log.step(`第 ${position + 1} / ${temsisList.length} 筆：${maskCode(temsis)}`);
    outcomes.push(await processTemsis(session.context, session.page, temsis, range));
  }
  return outcomes;
}

/** 把結果整理成終端機摘要。 */
export function printUnlockSummary(outcomes) {
  log.step('執行結果');
  for (const outcome of outcomes) {
    const line = `${maskCode(outcome.temsis)}　${outcome.status}　${outcome.detail}`;
    if (outcome.status === '已定位') log.ok(line);
    else log.warn(line);
  }
  const located = outcomes.filter((item) => item.status === '已定位').length;
  log.info(`共 ${outcomes.length} 筆：定位成功 ${located} 筆、其餘 ${outcomes.length - located} 筆需確認`);
  log.warn('本版為試跑，沒有任何案件被實際解鎖。');
}
