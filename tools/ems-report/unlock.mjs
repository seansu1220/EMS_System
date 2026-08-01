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
 * ⚠ 安全設計：**預設是試跑**（只找出目標，不按下「調整為未結案」），
 *   要真的解鎖必須明確加 `--execute`。解鎖是不可復原的寫入動作，
 *   且只有「明確定位到唯一目標」的案件才會動手，其餘一律略過。
 *
 * ⚠ 個資原則：紀錄表全文只存在記憶體，用完即棄；畫面與紀錄檔一律只顯示遮蔽後的編號末 4 碼。
 */
import { SITE, UNLOCK } from './config.mjs';
import { formatDateForSite } from './dateRange.mjs';
import { fillField, detectDateFormat } from './formFill.mjs';
import { log, prompt, startLineBuffering, stopLineBuffering } from './logger.mjs';
import { getFrame, gotoRecordQuery, gotoMenuItem } from './navigation.mjs';
import {
  findField,
  findClickables,
  clickMatch,
  findPairedRows,
  listFields,
  listClickableTexts,
  readRowFields,
  groupByRow,
} from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import {
  extractLabeledCode,
  extractLabeledValue,
  listSheetLabels,
  isSameCode,
  maskCode,
} from './sheetFields.mjs';

/**
 * @typedef {Object} UnlockOutcome
 * @property {string} temsis 使用者輸入的 TEMSIS（顯示時會遮蔽）
 * @property {'已解鎖'|'已定位'|'查無案件'|'需人工處理'|'失敗'} status
 * @property {string} detail 給人看的說明
 * @property {number} [unlockIndex] 目標是第幾個解鎖按鈕（0 起算）
 * @property {number} [recordIndex] 目標是第幾張紀錄表（0 起算）
 * @property {string|null} [caseDate] 案件日期（供事後追查，抓不到為 null）
 * @property {string|null} [vehicle] 該張紀錄表的派遣車輛（供事後追查，抓不到為 null）
 * @property {string|null} [squad] 該張紀錄表的派遣分隊
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
 * 找可點元素；一個都沒有時多等一輪再找一次。
 *
 * 查詢結果是非同步回填的，第一次找不到未必代表真的沒有——
 * 直接判定「查無案件」會冤枉掉存在的案件，多等一次的成本則很低。
 */
async function findClickablesWithRetry(page, textCandidates, options = {}) {
  const found = await findClickables(content(page), textCandidates, options);
  if (found.length > 0) return found;
  await page.waitForTimeout(UNLOCK.settleMs);
  return findClickables(content(page), textCandidates, options);
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
 * 從救護紀錄表查詢結果的那一列，讀出案件日期與出勤單位。
 *
 * 這是給使用者事後追查用的資訊。優先用這裡而不是 PDF：
 * 查詢結果是 HTML 表格，欄位有標題列可以對照；PDF 的文字順序則是
 * 「標題1 標題2 … 值1 值2 …」，抓標籤後面的字會抓到下一個標題（實測踩過）。
 *
 * @param {number} index 第幾個紀錄表按鈕（用來定位那一列）
 * @returns {Promise<{caseDate: string|null, vehicle: string|null, headers: string[]}>}
 */
async function readListRowInfo(page, index) {
  const row = await readRowFields(
    content(page),
    UNLOCK.buttonTexts.openRecordSheet,
    index,
    UNLOCK.listColumns.caseDate,
  ).catch(() => null);
  return {
    caseDate: pickFirstValue(row, UNLOCK.listColumns.caseDate),
    headers: row?.headers ?? [],
  };
}

/**
 * 依候選欄名的順序，取第一個有值的欄位。
 * @param {{values?: Record<string,string>}|null} row
 * @param {string[]} candidates
 * @returns {string|null}
 */
function pickFirstValue(row, candidates) {
  for (const name of candidates) {
    const value = row?.values?.[name];
    if (value) return value;
  }
  return null;
}

/**
 * 從案件內部「要解鎖的那一列」讀出派遣車輛與派遣分隊。
 *
 * 案件內部的表格是**一列一張紀錄表**，因此讀到的正是要解鎖的那一張所屬的車輛，
 * 而不是整件案子的（一件案子可能出動兩台車）。
 *
 * @param {number} recordIndex 目標紀錄表在該頁的序號
 * @returns {Promise<{vehicle: string|null, squad: string|null, headers: string[]}>}
 */
async function readCaseRowInfo(page, recordIndex) {
  const wanted = [...UNLOCK.caseColumns.vehicle, ...UNLOCK.caseColumns.squad];
  const row = await readRowFields(
    content(page),
    UNLOCK.buttonTexts.openRecordInCase,
    recordIndex,
    wanted,
  ).catch(() => null);
  return {
    vehicle: pickFirstValue(row, UNLOCK.caseColumns.vehicle),
    squad: pickFirstValue(row, UNLOCK.caseColumns.squad),
    headers: row?.headers ?? [],
  };
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
  // 日期與車輛只是留給使用者事後追查的參考，抓不到不影響解鎖。
  const caseDate = extractLabeledValue(sheet.text, UNLOCK.sheetLabels.caseDate, { maxLength: 24 });
  // 車號不含空白，只取第一段，才不會把同一行的下一個欄位也吃進來。
  const vehicle = extractLabeledValue(sheet.text, UNLOCK.sheetLabels.vehicle, {
    maxLength: 16,
    singleToken: true,
  });
  log.info(`紀錄表已讀取（${sheet.kind}／${sheet.source}），共 ${sheet.text.length} 個字元`);
  return {
    dispatchNo: dispatchNo?.value ?? null,
    temsis: temsis?.value ?? null,
    caseDate: caseDate?.value ?? null,
    vehicle: vehicle?.value ?? null,
    /** 值是從哪個欄位抓來的，印在紀錄裡讓使用者能一眼判斷抓對了沒。 */
    caseDateLabel: caseDate?.label ?? null,
    vehicleLabel: vehicle?.label ?? null,
    kind: sheet.kind,
    /** 欄位抓不到時用來排查的標籤清單（只有欄位名稱，沒有內容）。 */
    availableLabels: dispatchNo && caseDate && vehicle ? [] : listSheetLabels(sheet.text),
  };
}

/**
 * 真的按下「調整為未結案」。
 *
 * ⚠ 這是整個工具唯一會**改動系統資料**的地方，而且無法復原。
 * 呼叫前必須已經確定目標（`locateUnlockTarget` 回報「已定位」）。
 *
 * @param {number} unlockIndex 第幾個解鎖按鈕（0 起算）
 * @returns {Promise<{before: number, after: number, confirmed: boolean}>}
 */
export async function performUnlock(page, unlockIndex) {
  const countUnlockButtons = async () =>
    (await findClickables(content(page), UNLOCK.buttonTexts.unlock)).length;
  const before = await countUnlockButtons();

  // 系統很可能跳確認視窗。**Playwright 預設會自動按取消**，
  // 不自己接手的話會靜靜地什麼都沒解到，卻看起來像成功了。
  const onDialog = async (dialog) => {
    const message = dialog.message().replace(/\d{5,}/g, '#####').slice(0, 80);
    log.info(`系統跳出確認視窗：「${message}」→ 按下確定`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    const clicked = await clickMatch(content(page), UNLOCK.buttonTexts.unlock, unlockIndex);
    if (!clicked) {
      throw new Error(`按不到第 ${unlockIndex + 1} 個「${UNLOCK.buttonTexts.unlock[0]}」按鈕`);
    }
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(UNLOCK.settleMs);
  } finally {
    page.off('dialog', onDialog);
  }

  // 回讀驗證：解鎖成功的話，那一列的解鎖按鈕就不該再出現。
  const after = await countUnlockButtons();
  return { before, after, confirmed: after < before };
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

  const buttons = await findClickablesWithRetry(page, UNLOCK.buttonTexts.openRecordSheet);
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

  // 先從查詢結果那一列讀日期與出勤單位（HTML 表格有標題列可對照，比從 PDF 抓可靠）。
  const listInfo = await readListRowInfo(page, rows[0][0].index);

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
  // 使用者要求：解鎖時要能看出這是哪一天、哪一台車的案件，供事後回頭核對。
  // 日期取自查詢結果那一列（HTML 有標題列可對照）；讀不到才退回紀錄表 PDF 抽出來的值。
  const caseDate = listInfo.caseDate ?? codes.caseDate;
  if (caseDate) {
    log.info(`案件日期：${caseDate}（取自${listInfo.caseDate ? '查詢結果' : `紀錄表的「${codes.caseDateLabel}」`}）`);
  } else {
    log.warn('讀不到案件日期，請依實際欄名調整 config.mjs 的 UNLOCK.listColumns：');
    log.info(`　查詢結果的欄位：${listInfo.headers.join('｜') || '(讀不到表格)'}`);
  }
  // 出勤車輛不在這裡讀：一件案子可能出動兩台車，要等確定解哪一張紀錄表後，
  // 才從案件內部那一列讀（見 readCaseRowInfo）。
  return { dispatchNo: codes.dispatchNo, sheetTemsis: codes.temsis, caseDate };
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

/**
 * 等待畫面真的變成「案件內部」。
 *
 * 以畫面上出現特定字樣為準，而不是等固定秒數：頁面切換的快慢會隨網路與資料量變動，
 * 用時間猜必然有時對有時錯。
 *
 * ⚠ 只回傳「有沒有出現特徵字」這個布林值，不把頁面內容帶出來。
 *
 * @returns {Promise<boolean>}
 */
async function waitForCaseDetail(page) {
  const deadline = Date.now() + UNLOCK.caseDetailTimeoutMs;
  while (Date.now() < deadline) {
    if (await hasCaseDetail(page)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * 現在這一刻畫面是不是還在案件內部（只看一次，不等待）。
 *
 * ⚠ 同樣只回傳布林值，不把頁面內容帶出來。
 *
 * @returns {Promise<boolean>}
 */
async function hasCaseDetail(page) {
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
 * 步驟 5：在案件內部決定「該解哪一張紀錄表」。
 *
 * 只有一張時直接鎖定；多張時逐張開啟比對 TEMSIS，
 * **比對不到就回報需人工處理，絕不退而求其次挑一張**。
 *
 * @param {{readCodes?: typeof readSheetCodes, reenterCase?: () => Promise<void>}} [deps]
 *   `readCodes`：讀取紀錄表的方式（測試時可注入假的）。
 *   `reenterCase`：重新進入這件案子的方式。有些紀錄表按下去會把畫面導走，
 *   不先回到案件內部，後面幾張連按鈕都找不到。
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
    return {
      temsis,
      status: '已定位',
      unlockIndex: 0,
      recordIndex: paired.pairs[0]?.recordIndex ?? 0,
      detail: '案件內只有一張紀錄表，該張即為解鎖目標',
    };
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

  // 紀錄檔是給使用者看的，「第幾張」這種內部說法要順帶說明它代表什麼。
  log.info(`有 ${paired.recordCount} 張紀錄表，逐張開啟比對 TEMSIS`);
  log.info(`（同一件案子出動幾台車就有幾張紀錄表，逐張打開才知道你要的那筆是哪一張）`);
  // 找到相符就停下來比較快，但這樣「每一張讀到的是不是真的不同」就無從驗證
  // （若序號沒生效、每次都開到同一張，光看結果是看不出來的）。
  // 全部掃過的代價只是多開幾張，換到的是可核對的完整比對表，以及「多張相符」這種異常也能發現。
  const matches = [];
  /** 打不開的紀錄表：不能當成「不相符」，因為它有沒有相符根本不知道。 */
  const unopened = [];
  for (const [position, pair] of paired.pairs.entries()) {
    // 文字候選與 exact 都必須與上面 findPairedRows 完全一致，否則序號會對到別張紀錄表。
    let codes;
    try {
      codes = await readCodes(
        context,
        page,
        UNLOCK.buttonTexts.openRecordInCase,
        pair.recordIndex,
        {
          exact: false,
          // 有些紀錄表按下去不是另開視窗，而是把案件內部的畫面整個換掉。
          // 這種情況再等下去也不會有紀錄表，早點收手才不會白等一分鐘。
          shouldAbort: async () => (await hasCaseDetail(page)
            ? null
            : '畫面就離開了案件內部，紀錄表沒有開出來'),
        },
      );
    } catch (error) {
      // 單張打不開就整筆放棄的話，連「已經比對出來的結果」都會一起丟掉。
      // 這裡改成記下來繼續掃，最後再依「有沒有沒掃到的」決定能不能動手。
      const reason = error instanceof Error ? error.message : String(error);
      unopened.push({ recordIndex: pair.recordIndex, reason });
      log.warn(`  第 ${pair.recordIndex + 1} 張：打不開，無法比對（${reason}）`);
      // 畫面被換掉時，後面幾張連按鈕都找不到（實跑時第 3、4 張就是這樣連環失敗），
      // 因此先回到案件內部再繼續，不然剩下的等於全部沒掃到。
      if (!(await hasCaseDetail(page))) {
        const returned = deps.reenterCase
          ? await deps.reenterCase().then(() => true).catch(() => false)
          : false;
        if (!returned) {
          for (const skipped of paired.pairs.slice(position + 1)) {
            unopened.push({
              recordIndex: skipped.recordIndex,
              reason: '畫面已離開案件內部且回不去，沒有比對到',
            });
          }
          log.warn('  畫面已離開案件內部且回不去，其餘幾張都沒有比對到');
          break;
        }
        log.info('  畫面被導走，已重新進入案件內部，繼續比對下一張');
      }
      continue;
    }
    const isMatch = Boolean(codes.temsis) && isSameCode(codes.temsis, temsis);
    const shown = codes.temsis ? maskCode(codes.temsis) : '（讀不到 TEMSIS）';
    log.info(`  第 ${pair.recordIndex + 1} 張：${shown}　${isMatch ? '✅ 相符' : '不相符'}`);
    if (isMatch) matches.push(pair);
  }

  /** 打不開的張數描述，接在其他說明後面。 */
  const unopenedNote = unopened.length === 0 ? ''
    : `；另有第 ${unopened.map((item) => item.recordIndex + 1).join('、')} 張打不開`
      + `（${unopened[0].reason}）`;

  if (matches.length === 0) {
    return {
      temsis,
      status: '需人工處理',
      detail: unopened.length === paired.recordCount
        ? `${paired.recordCount} 張紀錄表全部打不開，無法比對（${unopened[0].reason}）`
        : `${paired.recordCount - unopened.length} 張打得開的紀錄表都沒有相符的 TEMSIS${unopenedNote}`,
    };
  }
  if (matches.length > 1) {
    // 同一件案子裡兩張紀錄表有相同的 TEMSIS 並不合理，寧可停下來讓人看。
    return {
      temsis,
      status: '需人工處理',
      detail: `有 ${matches.length} 張紀錄表的 TEMSIS 都相符`
        + `（第 ${matches.map((pair) => pair.recordIndex + 1).join('、')} 張），無法判斷該解哪一張`,
    };
  }

  const target = matches[0];
  if (target.unlockIndex < 0) {
    return {
      temsis,
      status: '需人工處理',
      recordIndex: target.recordIndex,
      detail: `第 ${target.recordIndex + 1} 張紀錄表的 TEMSIS 相符，`
        + '但同一列裡沒有解鎖按鈕，無法確定該按哪一個（不猜，請人工處理）',
    };
  }
  if (unopened.length > 0) {
    // 只有一張相符，但還有沒掃到的張數——萬一那張也相符，動手就是解錯張。
    // 目標仍照實回報（含車輛與日期），讓使用者可以自行到系統核對後手動處理。
    return {
      temsis,
      status: '需人工處理',
      recordIndex: target.recordIndex,
      detail: `第 ${target.recordIndex + 1} 張紀錄表的 TEMSIS 相符`
        + `（對應第 ${target.unlockIndex + 1} 個解鎖按鈕）`
        + `${unopenedNote}，無法確認沒有第二張也相符，因此不自動解鎖`,
    };
  }
  return {
    temsis,
    status: '已定位',
    unlockIndex: target.unlockIndex,
    recordIndex: target.recordIndex,
    detail: `第 ${target.recordIndex + 1} 張紀錄表的 TEMSIS 相符，`
      + `對應同一列的第 ${target.unlockIndex + 1} 個解鎖按鈕`,
  };
}

/**
 * 定位成功後，真的按下解鎖並確認結果。
 * @param {UnlockOutcome} outcome 會被就地補上解鎖後的狀態
 */
async function unlockLocatedTarget(page, outcome) {
  const caseInfo = `${outcome.caseDate ?? '日期讀不到'}　`
    + `${outcome.vehicle ?? outcome.squad ?? '車輛讀不到'}`;
  log.step(`按下「${UNLOCK.buttonTexts.unlock[0]}」（${caseInfo}）`);
  const result = await performUnlock(page, outcome.unlockIndex);

  if (result.confirmed) {
    outcome.status = '已解鎖';
    outcome.detail = `${outcome.detail}；已解鎖（解鎖按鈕由 ${result.before} 個減為 ${result.after} 個）`;
    log.ok(`已解鎖：${caseInfo}　TEMSIS ${maskCode(outcome.temsis)}`);
    return;
  }
  // 按了但畫面沒變化：可能沒生效，也可能系統本來就不會移除按鈕。不臆測，如實回報。
  outcome.status = '需人工處理';
  outcome.detail = `${outcome.detail}；已按下按鈕，但解鎖按鈕數量沒有變少`
    + `（前後都是 ${result.before} 個），無法確認是否生效，請自行到系統確認`;
  log.warn(`${maskCode(outcome.temsis)}：${outcome.detail}`);
}

/**
 * 處理一筆 TEMSIS。
 * @param {{dryRun: boolean}} options dryRun＝true 時只定位，不按下解鎖
 * @returns {Promise<UnlockOutcome>}
 */
async function processTemsis(context, page, temsis, range, options) {
  try {
    const caseInfo = await findDispatchNoByTemsis(context, page, temsis, range);
    await openCaseByDispatchNo(context, page, caseInfo.dispatchNo, range);
    const outcome = await locateUnlockTarget(context, page, temsis, {
      // 走同一條路重新查一次案件；比對到一半畫面被導走時才用得到。
      reenterCase: () => openCaseByDispatchNo(context, page, caseInfo.dispatchNo, range),
    });
    outcome.caseDate = caseInfo.caseDate;
    log[outcome.status === '已定位' ? 'ok' : 'warn'](`${maskCode(temsis)}：${outcome.detail}`);

    // 確定是哪一張之後，才讀得到「那一張」所屬的車輛（一件案子可能出動兩台車）。
    // 只要知道是哪一列就讀，「需人工處理」也一樣——那正是使用者要拿去人工核對的線索。
    if (typeof outcome.recordIndex === 'number' && outcome.recordIndex >= 0) {
      const caseRow = await readCaseRowInfo(page, outcome.recordIndex);
      outcome.vehicle = caseRow.vehicle;
      outcome.squad = caseRow.squad;
      if (caseRow.vehicle || caseRow.squad) {
        log.info(`出勤車輛：${caseRow.vehicle ?? '（讀不到）'}　派遣分隊：${caseRow.squad ?? '（讀不到）'}`);
      } else {
        log.warn('讀不到出勤車輛，請依實際欄名調整 config.mjs 的 UNLOCK.caseColumns：');
        log.info(`　案件內部表格的欄位：${caseRow.headers.join('｜') || '(讀不到表格)'}`);
      }
    }

    // 只有明確定位到目標才會動手；其餘狀態一律略過，交給人處理。
    if (outcome.status === '已定位' && !options.dryRun) {
      await unlockLocatedTarget(page, outcome);
    }
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
  log.info('可以一次貼上整欄（多行一起貼沒問題），也可以一行貼一個再按 Enter。');
  log.info('全部貼完後，在「空白的那一行」再按一次 Enter，才會開始執行。');
  log.info('（只有一筆的話就是：貼上 → Enter → 再按一次 Enter）');
  log.info('貼不上去時：在黑色視窗內按「滑鼠右鍵」就是貼上（Ctrl+V 常被輸入法吃掉）。');
  /** @type {string[]} */
  const collected = [];
  // 一次貼上整欄號碼時，多出來的行會在兩次 prompt 之間到達，必須先開緩衝才不會漏。
  await startLineBuffering();
  try {
    for (;;) {
      // 提示字串刻意維持**短且純 ASCII**：Windows 傳統主控台（conhost）上，
      // readline 按下 Enter 後會依提示字寬重繪該行，提示含全形字或整行過長時
      // 會把剛輸入的內容抹掉——讀是讀到了，但使用者看不到自己貼了什麼。
      const line = await prompt(`  [${collected.length + 1}] `);
      // null 代表輸入串流結束（EOF），空字串代表使用者按了 Enter，兩者都視為輸入完畢。
      if (line === null || line === '') break;
      collected.push(...line.split(/[\s,，;；]+/).filter(Boolean));
      // 上面那行可能被主控台抹掉，因此另外印一行回條，讓使用者確定收到了幾筆。
      log.info(`已收到 ${collected.length} 筆`);
    }
  } finally {
    stopLineBuffering();
  }
  return [...new Set(collected)];
}

/**
 * 解鎖流程主入口。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {{temsisList: string[], range: import('./dateRange.mjs').MonthRange,
 *   dryRun?: boolean}} options dryRun＝true 時只定位、不解鎖
 * @returns {Promise<UnlockOutcome[]>}
 */
export async function runUnlockFlow(session, options) {
  const { temsisList, range, dryRun = false } = options;
  if (dryRun) {
    log.step(`試跑模式：只找出「該解哪一張」，不會按下「${UNLOCK.buttonTexts.unlock[0]}」`);
  } else {
    log.step(`正式模式：定位到目標後會**實際按下**「${UNLOCK.buttonTexts.unlock[0]}」`);
    log.info('定位不明確的案件一律略過，不會亂解。每筆都會記下案件日期與出勤車輛供事後核對。');
  }
  log.info(`查詢期間：${range.start} ~ ${range.end}（${range.label}）`);
  log.info(`共 ${temsisList.length} 筆 TEMSIS 要處理`);

  /** @type {UnlockOutcome[]} */
  const outcomes = [];
  for (const [position, temsis] of temsisList.entries()) {
    log.step(`第 ${position + 1} / ${temsisList.length} 筆：${maskCode(temsis)}`);
    outcomes.push(await processTemsis(session.context, session.page, temsis, range, { dryRun }));
  }
  return outcomes;
}

/**
 * 把結果整理成終端機摘要。
 *
 * 每一列都帶上案件日期與出勤車輛：使用者無法逐筆人工比對，
 * 這份紀錄是他日後回頭查「到底解了哪些案件」的唯一依據（使用者 2026-07-31 指定）。
 */
export function printUnlockSummary(outcomes, options = {}) {
  log.step('執行結果');
  // 日期與車輛擺在最前面：這是使用者事後回頭追查案件時最先要找的兩個欄位。
  const pad = (text, width) => {
    const value = String(text ?? '');
    // 中文字在終端機約佔兩個字元寬，補空白時要算進去才對得齊。
    const displayWidth = [...value].reduce((sum, char) => sum + (/[一-龥]/.test(char) ? 2 : 1), 0);
    return value + ' '.repeat(Math.max(0, width - displayWidth));
  };
  for (const outcome of outcomes) {
    // 車輛後面附上分隊（例如「平鎮92（平鎮分隊）」），事後回頭找案件比較好認。
    const vehicle = outcome.vehicle
      ? `${outcome.vehicle}${outcome.squad ? `（${outcome.squad}）` : ''}`
      : outcome.squad ?? '車輛讀不到';
    const line = `${pad(outcome.caseDate ?? '日期讀不到', 22)}${pad(vehicle, 20)}`
      + `${maskCode(outcome.temsis)}　${outcome.status}　${outcome.detail}`;
    if (outcome.status === '已解鎖' || outcome.status === '已定位') log.ok(line);
    else log.warn(line);
  }

  const unlocked = outcomes.filter((item) => item.status === '已解鎖').length;
  const located = outcomes.filter((item) => item.status === '已定位').length;
  const rest = outcomes.length - unlocked - located;
  if (options.dryRun) {
    log.info(`共 ${outcomes.length} 筆：定位成功 ${located} 筆、其餘 ${rest} 筆需確認`);
    log.warn('本次為試跑，沒有任何案件被實際解鎖。');
    return;
  }
  log.info(`共 ${outcomes.length} 筆：已解鎖 ${unlocked} 筆、未處理 ${outcomes.length - unlocked} 筆`);
  if (unlocked < outcomes.length) {
    log.warn('未解鎖的案件請自行到系統處理（原因見上方每一列的說明）。');
  }
}
