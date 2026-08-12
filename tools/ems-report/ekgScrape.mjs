/**
 * 心電圖流程的查詢與匯出：在救護紀錄表查詢頁跑兩次查詢，各匯出一份 Excel。
 *
 *   1. 分母：勾選「EKG檢查」→ 查詢 → 匯出（做過 EKG 檢查的案件）
 *   2. 分子：心電圖下拉＝「12導程心電圖」→ 查詢 → 匯出（做了 12 導程的案件）
 *
 * **兩次都只設查詢期間，不設救護狀態與送醫情形**（使用者 2026-08-03 決定：兩個都不限）。
 * 兩次的基準條件必須一模一樣，否則分子分母不同口徑，比率沒有意義——
 * 因此設定條件時會把上一次用過的條件明確清掉，而不是靠「重新載入頁面應該會是空的」。
 *
 * ⚠ 個資原則：匯出檔含個案明細，只落在本機 out/raw/，統計後即刪除。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE, PATHS, EKG, QUERY_CRITERIA } from './config.mjs';
import { formatDateForSite } from './dateRange.mjs';
import { log } from './logger.mjs';
import {
  fillField as fillFrameField,
  selectField as selectFrameField,
  setCheckbox as setFrameCheckbox,
  detectDateFormat as detectFrameDateFormat,
} from './formFill.mjs';
import { getFrame, gotoRecordQuery, ensureFieldVisible } from './navigation.mjs';
import {
  findCheckbox,
  findSelectByOption,
  listCheckboxLabels,
  listSelects,
} from './pageFinder.mjs';
import { runQuery, exportExcelWithRetry } from './scrape.mjs';

/**
 * @typedef {Object} EkgFields
 * @property {string} procedureSelector 「EKG檢查」勾選框
 * @property {string} ecgSelector 「心電圖」下拉
 * @property {string} twelveLeadValue 12 導程那個選項的 value
 * @property {string} twelveLeadText 12 導程那個選項的文字（供人核對）
 */

/** 取得目前的內容框（每次導航都會重建，不可快取）。 */
function content(page) {
  return getFrame(page, SITE.frames.content);
}

/**
 * 把欄位捲進畫面（必要時展開進階搜尋）。
 *
 * 展不開也**不中斷**：欄位就算收合著，`setCheckbox`／`selectField` 仍會直接寫入值並回讀驗證，
 * 結果一樣正確。展開只是為了讓使用者在瀏覽器上看得到程式在動什麼。
 */
async function tryReveal(page, selector, label) {
  await ensureFieldVisible(page, selector).catch((error) => {
    log.info(`${label} 展不開（${error instanceof Error ? error.message : String(error)}），改用直接寫入`);
  });
}

/**
 * 找出「EKG檢查」勾選框與「心電圖」下拉。
 *
 * 兩者都**沒有經過探測**，因此以畫面文字定位（見 pageFinder.mjs）：
 * 勾選框靠旁邊的文字、下拉靠「12導程心電圖」這個選項反推。
 * 找不到就中止並列出這一頁實際有什麼，不猜欄位——猜錯會產出看起來正常但完全錯誤的報表。
 *
 * @returns {Promise<EkgFields>}
 */
export async function locateEkgFields(page) {
  log.step('定位「EKG檢查」勾選框與「心電圖」下拉');
  // 兩個欄位都在進階搜尋區塊內，先展開，找起來與看起來都比較踏實。
  await ensureFieldVisible(page, SITE.queryFields.prehospitalAlert).catch(() => {});

  const checkbox = await findCheckbox(content(page), EKG.procedureLabels);
  if (!checkbox) {
    const available = await listCheckboxLabels(content(page)).catch(() => []);
    throw new Error(
      `找不到「EKG檢查」勾選框（試過的字樣：${EKG.procedureLabels.join('、')}）。`
        + `這一頁的勾選框旁邊寫著：${available.join('｜') || '(一個都讀不到)'}。`
        + '請把正確字樣加進 config.mjs 的 EKG.procedureLabels。',
    );
  }
  log.ok(`EKG檢查＝${checkbox.selector}（${checkbox.matchedBy}：「${checkbox.labelText}」）`);

  const select = await findSelectByOption(content(page), EKG.twelveLeadOptionTexts);
  if (!select) {
    const available = await listSelects(content(page)).catch(() => []);
    const summary = available
      .map((item) => `${item.selector}（${item.nearbyText || '無標籤'}／${item.optionCount} 項：${item.sampleOptions.join('、')}）`)
      .join('\n    ');
    throw new Error(
      `找不到含「12導程心電圖」選項的下拉（試過：${EKG.twelveLeadOptionTexts.join('、')}）。`
        + `\n  這一頁的下拉有：\n    ${summary || '(一個都讀不到)'}`
        + '\n  請把正確的選項文字加進 config.mjs 的 EKG.twelveLeadOptionTexts。',
    );
  }
  log.ok(
    `心電圖下拉＝${select.selector}（${select.matchedBy}：「${select.optionText}」，`
      + `value=${select.optionValue}${select.nearbyText ? `，旁邊寫著「${select.nearbyText}」` : ''}）`,
  );

  return {
    procedureSelector: checkbox.selector,
    ecgSelector: select.selector,
    twelveLeadValue: select.optionValue,
    twelveLeadText: select.optionText,
  };
}

/**
 * 設定兩次查詢共通的條件：只有查詢期間。
 *
 * 救護狀態與送醫情形**明確設成「不限」**而不是放著不管：
 * 兩次查詢之間頁面不會重載，上一次選過的值會留著，
 * 靠「應該是空的」來假設條件正確，正是這個系統最容易出錯的地方。
 */
export async function applyBaseCriteria(page, monthRange, criteria = {}) {
  // 預設取自 `EKG.baseCriteria`（目前是「已結案＋送醫」，使用者 2026-08-05 決定）。
  // 診斷指令會明確傳入空字串來量「不限」的件數，因此這裡用 `??` 而非 `||`
  // ——空字串是「刻意不限」，不可以被預設值蓋掉。
  const rescueStatus = criteria.rescueStatus ?? EKG.baseCriteria.rescueStatus;
  const transport = criteria.transport ?? EKG.baseCriteria.transport;
  const describe = (value, limited) => (value ? limited : '不限');
  log.step(
    `設定查詢期間（救護狀態＝${describe(rescueStatus, QUERY_CRITERIA.rescueStatusLabel)}、`
      + `送醫情形＝${describe(transport, QUERY_CRITERIA.transportLabel)}）`,
  );
  const dateFormat = await detectFrameDateFormat(
    content(page),
    SITE.queryFields.dateFrom,
    SITE.defaultDateFormat,
  );
  await fillFrameField(
    content(page),
    SITE.queryFields.dateFrom,
    formatDateForSite(monthRange.start, dateFormat),
    '起日',
  );
  // 迄日必須是 23:59:59，否則格式含時間時會變成當天 00:00:00，漏掉整個最後一天。
  await fillFrameField(
    content(page),
    SITE.queryFields.dateTo,
    formatDateForSite(monthRange.end, dateFormat, { endOfDay: true }),
    '迄日',
  );

  // 訊息一律顯示**看得懂的名稱**而不是代碼：紀錄檔是給人核對「條件有沒有設對」的，
  // 寫「救護狀態＝0」沒人看得出那是已結案還是未結案。
  for (const [selector, label, value, shown] of [
    [SITE.queryFields.rescueStatus, '救護狀態', rescueStatus, QUERY_CRITERIA.rescueStatusLabel],
    [SITE.queryFields.transport, '送醫情形', transport, QUERY_CRITERIA.transportLabel],
    // 院前預警與心電圖無關，一律清空，免得上一次查詢的值留著。
    [SITE.queryFields.prehospitalAlert, '院前預警', '', ''],
  ]) {
    await tryReveal(page, selector, label);
    await selectFrameField(content(page), selector, value, `${label}＝${value ? shown : '不限'}`);
  }
}

/**
 * 找出「急救處置」裡的 **CPR 勾選框**（與 EKG檢查同一區）。
 *
 * 用途：使用者 2026-08-12 給的規則——**處置勾了 CPR 就是 OHCA 案件**，
 * 那些案件要排除在 12 導程傳輸率的分母與分子之外（見 `EKG.excludeCprCases`）。
 *
 * 找不到就**中止**並列出這一頁的勾選框旁邊各寫著什麼：這條規則會直接改動報表數字，
 * 勾錯一個框會產出看起來正常、實際完全錯誤的報表。
 *
 * @returns {Promise<{selector: string, label: string}>}
 */
export async function locateCprCheckbox(page) {
  const checkbox = await findCheckbox(content(page), EKG.cprLabels);
  if (!checkbox) {
    const available = await listCheckboxLabels(content(page)).catch(() => []);
    throw new Error(
      `找不到「CPR」勾選框（試過：${EKG.cprLabels.join('、')}）。`
        + `這一頁的勾選框旁邊寫著：${available.join('｜') || '(一個都讀不到)'}。`
        + '請把正確字樣加進 config.mjs 的 EKG.cprLabels。',
    );
  }
  log.ok(`CPR＝${checkbox.selector}（${checkbox.matchedBy}：「${checkbox.labelText}」）`);
  if (!checkbox.matchedBy.includes('完全相符')) {
    log.warn(
      '　⚠ 這是「包含」比對到的，可能勾到「旁觀者CPR」之類的別的框。'
        + '請看畫面確認，不對的話把正確字樣加進 EKG.cprLabels。',
    );
  }
  return { selector: checkbox.selector, label: `CPR（${checkbox.labelText}）` };
}

/**
 * 設定其中一次查詢的條件，然後查詢並匯出。
 *
 * 診斷指令（`ekg-diag`）也用這一支去量各種條件組合的件數，
 * 兩邊走完全同一條路，量出來的數字才和正式流程對得起來。
 *
 * @param {EkgFields} fields
 * @param {{key: string, label: string, procedureChecked: boolean, ecgValue: string,
 *   ecgLabel?: string,
 *   extraCheckboxes?: {selector: string, checked: boolean, label: string}[]}} dataset
 *   `ecgLabel`＝這次選的心電圖類型叫什麼（只影響畫面訊息）。不給就當成 12 導程。
 *   `extraCheckboxes`＝其他要設定的勾選框，**每次查詢都要完整列出**（見下方註解）。
 * @returns {Promise<string>} 匯出檔路徑
 */
export async function queryAndExport(context, page, fields, dataset, monthRange) {
  log.step(`查詢並匯出：${dataset.label}`);

  await tryReveal(page, fields.procedureSelector, 'EKG檢查');
  await setFrameCheckbox(
    content(page),
    fields.procedureSelector,
    dataset.procedureChecked,
    'EKG檢查',
  );

  // 其他要一併設定的勾選框（目前只有診斷用的 CPR）。
  // ⚠ 呼叫端**每一次查詢都要把它們列出來並指定 true/false**，不能只在要勾的那次傳。
  //   少傳一次，上一輪勾的就會留著，後面每一次查詢都被多加了一個條件。
  for (const extra of dataset.extraCheckboxes ?? []) {
    await tryReveal(page, extra.selector, extra.label);
    await setFrameCheckbox(content(page), extra.selector, extra.checked, extra.label);
  }

  await tryReveal(page, fields.ecgSelector, '心電圖');
  // ⚠ 訊息一定要用**這次真正選的**那個類型的名字。
  //   舊版寫死 `fields.twelveLeadText`，於是 `ekg-ohca` 查 OHCA 時畫面上照樣印
  //   「心電圖＝12導程心電圖（已確認）」——值其實是對的（件數 284／18／18 明顯不同），
  //   但訊息看起來像三次都查同一個條件，整份診斷結果都會被懷疑（2026-08-12 實跑發現）。
  await selectFrameField(
    content(page),
    fields.ecgSelector,
    dataset.ecgValue,
    dataset.ecgValue ? `心電圖＝${dataset.ecgLabel ?? fields.twelveLeadText}` : '心電圖＝不限',
  );

  log.info('按下查詢，等待結果');
  await runQuery(page);
  log.info('按下匯出EXCEL，等待下載');
  const targetPath = path.join(PATHS.rawDir, `${monthRange.label}-ekg-${dataset.key}.xls`);
  return exportExcelWithRetry(context, page, targetPath);
}

/**
 * 跑完心電圖流程的查詢與匯出。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<{denominator: string, numerator: string, cpr: string|null, fields: EkgFields}>}
 *   `cpr`＝處置勾了 CPR 的案件（要排除的那批）；`EKG.excludeCprCases` 關掉時為 null
 */
export async function exportEkgDatasets(context, page, monthRange) {
  await fs.mkdir(PATHS.rawDir, { recursive: true });

  log.step('開啟救護紀錄表查詢');
  const route = await gotoRecordQuery(page);
  log.ok(`已開啟（${route}）`);

  const fields = await locateEkgFields(page);
  const cprBox = EKG.excludeCprCases ? await locateCprCheckbox(page) : null;
  await applyBaseCriteria(page, monthRange);

  /**
   * CPR 勾選框的設定。
   *
   * ⚠ **每一次查詢都要明講勾或不勾**。這系統的查詢條件會殘留，只在要勾的那次傳的話，
   *   後面每一次查詢都被偷偷多加了一個條件，件數全部是錯的。
   */
  const withCpr = (checked) => (cprBox ? [{ ...cprBox, checked }] : []);

  const denominator = await queryAndExport(
    context,
    page,
    fields,
    {
      key: 'denominator',
      label: '分母：EKG檢查案件',
      procedureChecked: true,
      ecgValue: '',
      extraCheckboxes: withCpr(false),
    },
    monthRange,
  );

  // 分子預設**不勾** EKG檢查（照使用者描述的操作：兩次查詢各用各的條件）。
  // 12 導程本來就是 EKG 的一種，勾不勾理論上結果相同；真要一起勾就改 config 的
  // EKG.keepProcedureCheckedForNumerator，不必動程式。
  const numerator = await queryAndExport(
    context,
    page,
    fields,
    {
      key: 'numerator',
      label: `分子：${fields.twelveLeadText}案件`,
      procedureChecked: EKG.keepProcedureCheckedForNumerator,
      ecgValue: fields.twelveLeadValue,
      extraCheckboxes: withCpr(false),
    },
    monthRange,
  );

  /**
   * 要排除的那批：**整個月處置勾了 CPR 的案件**（心電圖不限、EKG檢查不勾）。
   *
   * 刻意不加心電圖條件：分母是聯集，CPR 案件可能從「勾EKG檢查」那一邊進來，
   * 只查「12導程＋CPR」會漏掉那些。撈全部再跟分母取交集才排得乾淨。
   */
  const cpr = cprBox
    ? await queryAndExport(
      context,
      page,
      fields,
      {
        key: 'cpr',
        label: '要排除的：處置勾了CPR的案件（OHCA）',
        procedureChecked: false,
        ecgValue: '',
        extraCheckboxes: withCpr(true),
      },
      monthRange,
    )
    : null;

  return { denominator, numerator, cpr, fields };
}
