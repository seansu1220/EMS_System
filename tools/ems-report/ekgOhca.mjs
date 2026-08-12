/**
 * OHCA 對撞診斷（`ekg-ohca`）——**只查不算，不動任何正式報表**。
 *
 * 起因（使用者 2026-08-12）：三民 7/12 那件「其實是 OHCA 心電圖，不是 12 導程」。
 * 先前已查證**查詢條件沒有抓錯**——心電圖下拉本來就把「12導程心電圖」與
 * 「到院前／到院後 OHCA心電圖」分成不同選項，程式選的是 12 導程那個且套用後有回讀驗證。
 * 所以那件在**系統資料裡**就掛在 12 導程底下，問題出在來源資料。
 *
 * 這支要回答的是「這種誤標到底有多少件」，兩條路互相印證：
 *
 *   一、**條件對撞**：用 OHCA 兩個選項各查一次，看有沒有案件同時出現在 12 導程那份裡。
 *       有重疊 → 同一件被掛了兩種心電圖，那是分母被灌水的直接證據。
 *   二、**看救護紀錄表**：對指定的案件抓紀錄表，數 OHCA 相關字樣出現幾次。
 *       ⚠ 紀錄表是**表單**，欄位標籤每張都印著，所以「有出現」不等於「是 OHCA」。
 *       因此一定要**同時抓一件對照案件**比較，才知道哪個字樣真的有鑑別力。
 *
 * ⚠ 個資原則（比照 `ekgDiagnose.mjs`，這支更嚴格）：
 *   - 匯出檔只用來數筆數與比對 TEMSIS，讀進記憶體後立刻刪檔
 *   - 紀錄表全文**只在記憶體裡數次數**，不落檔、不印出內容
 *   - 畫面上只印**欄位標籤**（表單結構）與**命中次數**，不印任何欄位的值
 *   - TEMSIS 一律只印末 4 碼
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { EKG, PATHS, UNLOCK, SQUAD_COLUMN_CANDIDATES } from './config.mjs';
import { resolveColumnByNames, resolveSquadColumn } from './aggregate.mjs';
import { content } from './caseFlow.mjs';
import { applyBaseCriteria, locateEkgFields, queryAndExport } from './ekgScrape.mjs';
import { queryByTemsis } from './ekgVerify.mjs';
import { buildListSheet } from './ekgLists.mjs';
import { log } from './logger.mjs';
import { gotoRecordQuery } from './navigation.mjs';
import { findCheckbox, findSelectByOption, listCheckboxLabels } from './pageFinder.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import { extractLabeledValue, listSheetLabels, maskCode } from './sheetFields.mjs';
import { readTable } from './workbook.mjs';
import ExcelJS from 'exceljs';

/**
 * @typedef {Object} EcgOption 心電圖下拉裡的一個選項
 * @property {string} key 內部代號
 * @property {string} label 給人看的名稱
 * @property {string} value 選項的 value（拿來設定查詢條件）
 * @property {string} text 選項文字（供人核對抓對了沒）
 */

/**
 * @typedef {Object} SheetProbe 一張救護紀錄表的探測結果（**不含任何欄位的值**）
 * @property {string} temsis
 * @property {string} squad
 * @property {number} length 紀錄表全文字數（判斷有沒有讀到完整內容）
 * @property {{marker: string, count: number}[]} hits 各字樣出現次數
 * @property {{label: string, value: string}[]} values OHCA 判斷欄位填了什麼（已截短）
 * @property {string[]} labels 表單上的欄位標籤（結構，非個資）
 */

/**
 * 讀出救護紀錄表上幾個「判斷是不是 OHCA」的欄位值（純函式）。
 *
 * ⚠ 只讀 `EKG.ohca.sheetValueLabels` 列出的欄位，值再截短到
 * `sheetValueMaxLength`——其餘欄位一概不碰。
 *
 * @param {string} text 紀錄表全文
 * @returns {{label: string, value: string}[]} 每個欄位一筆；讀不到的寫「(空白)」
 */
export function readOhcaFields(text) {
  return EKG.ohca.sheetValueLabels.map((candidates) => {
    const found = extractLabeledValue(text, candidates, {
      maxLength: EKG.ohca.sheetValueMaxLength,
    });
    return { label: candidates[0], value: cutAtNextLabel(found?.value) || '(空白)' };
  });
}

/**
 * 「下一個欄位的標籤」的樣子：兩到十二個中英文字後面接冒號。
 * 紀錄表 PDF 取出來的文字沒有欄位邊界，一個值會一路吃到下一個標籤為止。
 */
const NEXT_LABEL_PATTERN = /[一-龥A-Za-z][一-龥A-Za-z0-9]{1,11}\s*[:：]/;

/**
 * 把一個欄位值切到「下一個標籤出現之前」。
 *
 * ⚠ 少了這一步，`旁觀者CPR：有 使用PAD：無 ROSC：08:12` 會整串當成
 * 旁觀者CPR 的值（2026-08-12 測試抓到）——兩件比對時就完全看不出差別，
 * 而且會把沒要讀的欄位內容一起帶出來。
 *
 * @param {string|undefined} value
 * @returns {string} 切好並去掉前後空白的值；沒有值時回傳空字串
 */
function cutAtNextLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const next = NEXT_LABEL_PATTERN.exec(text);
  return (next ? text.slice(0, next.index) : text).trim();
}

/** 找出一個 OHCA 選項的 value；找不到回傳 null（讓呼叫端決定要不要中止）。 */
async function resolveOption(page, key, label, optionTexts) {
  const found = await findSelectByOption(content(page), optionTexts);
  if (!found) {
    log.warn(`找不到「${label}」這個選項（試過：${optionTexts.join('、')}），這一項跳過`);
    return null;
  }
  return { key, label, value: found.optionValue, text: found.optionText, selector: found.selector };
}

/**
 * 找出心電圖下拉裡 12 導程與兩個 OHCA 選項的 value。
 *
 * ⚠ 三個選項**必須來自同一個下拉**。不同的話代表畫面上不只一個心電圖欄位，
 * 那三次查詢就不是同一個維度的比較，對撞出來的結論會是錯的——因此直接中止。
 *
 * @returns {Promise<{fields: import('./ekgScrape.mjs').EkgFields, options: EcgOption[]}>}
 */
export async function resolveEcgOptions(page) {
  const fields = await locateEkgFields(page);

  const candidates = [
    ['beforeArrival', '到院前OHCA心電圖', EKG.ohca.optionTexts.beforeArrival],
    ['afterArrival', '到院後OHCA心電圖', EKG.ohca.optionTexts.afterArrival],
  ];
  const ohcaOptions = [];
  for (const [key, label, optionTexts] of candidates) {
    const option = await resolveOption(page, key, label, optionTexts);
    if (!option) continue;
    if (option.selector !== fields.ecgSelector) {
      throw new Error(
        `「${label}」在 ${option.selector}，但 12 導程在 ${fields.ecgSelector}——`
          + '兩個選項不在同一個下拉，代表畫面上不只一個心電圖欄位。'
          + '這種情況對撞出來的結論不可信，先停下來讓你看畫面。',
      );
    }
    ohcaOptions.push(option);
    log.ok(`${label}＝value ${option.value}（選項文字「${option.text}」）`);
  }

  const options = [
    { key: 'twelveLead', label: '12導程心電圖', value: fields.twelveLeadValue, text: fields.twelveLeadText },
    ...ohcaOptions,
  ];
  return { fields, options };
}

/**
 * 每一種心電圖類型各查一次並匯出，讀進記憶體後立刻刪檔。
 *
 * 每一次查詢都套用**同一組基準條件**（已結案＋送醫，與正式報表同口徑），
 * 否則對撞出來的差異可能只是條件不同造成的。
 *
 * @param {{selector: string, label: string}} cpr CPR 勾選框
 * @returns {Promise<Map<string, import('./workbook.mjs').TableData>>} key → 資料表
 */
async function exportByEcgType(context, page, monthRange, fields, options, cpr) {
  await fs.mkdir(PATHS.rawDir, { recursive: true });
  const tables = new Map();

  for (const option of options) {
    await applyBaseCriteria(page, monthRange, EKG.baseCriteria);
    const filePath = await queryAndExport(
      context,
      page,
      fields,
      {
        // ⚠ CPR **每一次都要明講勾或不勾**。只在要勾的那次傳的話，上一輪勾的會留著，
        //   後面每一次查詢都被偷偷多加了一個條件，件數全部是錯的。
        extraCheckboxes: [{ ...cpr, checked: option.cprChecked === true }],
        key: `ohca-${option.key}`,
        label: `心電圖＝${option.label}${option.cprChecked ? '　＋處置勾 CPR' : ''}`,
        // 對撞只看心電圖這一個維度，因此**一律不勾** EKG檢查，
        // 免得三次查詢的差異混進「有沒有勾處置」這個變數。
        procedureChecked: false,
        ecgValue: option.value,
        ecgLabel: option.label,
      },
      monthRange,
    );
    try {
      // ⚠ `readTable` 是同步的，而且**第二個參數必填**——它靠這些欄名候選找出標題列
      //   （匯出檔前面有幾列說明）。漏掉會變成 `undefined.map`，錯誤訊息看不出原因。
      tables.set(option.key, readTable(filePath, SQUAD_COLUMN_CANDIDATES));
    } finally {
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
    log.ok(`${option.label}：${tables.get(option.key).rows.length} 件`);
  }
  return tables;
}

/**
 * 找出同時出現在兩份查詢結果裡的案件（純函式）。
 *
 * @param {import('./workbook.mjs').TableData} left
 * @param {import('./workbook.mjs').TableData} right
 * @param {string} temsisColumn 兩份共用的 TEMSIS 欄名
 * @returns {Record<string, unknown>[]} `left` 裡也出現在 `right` 的那些列
 */
export function rowsAlsoIn(left, right, temsisColumn) {
  const keyOf = (row) => String(row?.[temsisColumn] ?? '').trim();
  const otherKeys = new Set(right.rows.map(keyOf).filter(Boolean));
  return left.rows.filter((row) => {
    const key = keyOf(row);
    return key !== '' && otherKeys.has(key);
  });
}

/**
 * 數一段文字裡各個字樣出現幾次（純函式）。
 *
 * ⚠ 只回傳**次數**，不回傳前後文——救護紀錄表全文含個案資料。
 *
 * @param {string} text
 * @param {string[]} markers
 * @returns {{marker: string, count: number}[]} 只含有命中的，依次數由多到少
 */
export function countMarkerHits(text, markers) {
  const source = String(text ?? '');
  return markers
    .map((marker) => {
      let count = 0;
      let from = 0;
      for (;;) {
        const at = source.indexOf(marker, from);
        if (at < 0) break;
        count += 1;
        from = at + marker.length;
      }
      return { marker, count };
    })
    .filter((item) => item.count > 0)
    // 次數相同時依字樣排序（與其他統計一致用 zh-Hant），讓兩次跑出來的順序一樣。
    .sort((left, right) => right.count - left.count
      || left.marker.localeCompare(right.marker, 'zh-Hant'));
}

/**
 * 抓一件案件的救護紀錄表，回報字樣命中次數與表單欄位標籤。
 *
 * @returns {Promise<SheetProbe|null>} 查不到案件時回傳 null
 */
async function probeRecordSheet(context, page, temsis, squad, monthRange) {
  const rowIndex = await queryByTemsis(page, temsis, monthRange);
  if (rowIndex < 0) {
    log.warn(`${maskCode(temsis)}：查不到案件，跳過`);
    return null;
  }
  const sheet = await openRecordSheet(context, content(page), UNLOCK.buttonTexts.openRecordSheet, rowIndex);
  const hits = countMarkerHits(sheet.text, EKG.ohca.sheetMarkers);
  const values = readOhcaFields(sheet.text);

  log.step(`救護紀錄表：${squad || '(不知分隊)'}　${maskCode(temsis)}`);
  log.info(`　讀到 ${sheet.text.length} 個字元（${sheet.kind}／${sheet.source}）`);
  log.info(`　命中字樣（僅供參考，多半是印好的欄位標籤）：${describeHits(hits)}`);
  log.info(`　OHCA 判斷欄位：${values.map((item) => `${item.label}＝${item.value}`).join('　')}`);

  return {
    temsis,
    squad,
    length: sheet.text.length,
    hits,
    values,
    // 欄位標籤屬**表單結構**（非個案資料），列出來才知道該用哪一欄判斷 OHCA。
    labels: listSheetLabels(sheet.text, 60),
  };
}

/** 把命中結果整理成一行字（給終端機與報告用）。 */
const describeHits = (hits) => hits.map((item) => `${item.marker}×${item.count}`).join('、') || '無';

/**
 * 把對撞結果寫成一份內部清冊。
 *
 * 落在 `out/internal/`：含完整 TEMSIS 與逐案判定，與逐案判定表同一個標準，
 * **不是要發給分隊的東西**。
 *
 * @returns {Promise<string>} 檔案路徑
 */
async function writeOhcaReport(monthRange, counts, overlaps, probes, cprCases) {
  const workbook = new ExcelJS.Workbook();
  const title = `${monthRange.label}　心電圖類型對撞診斷`;

  buildListSheet(
    workbook,
    '各類型件數',
    title,
    ['心電圖類型', '件數'],
    counts.map((item) => [item.label, item.count]),
  );

  // 這是整份診斷最有用的一頁：掛 12 導程、但處置勾了 CPR ＝ 實際是 OHCA。
  if (cprCases.length > 0) {
    const tally = new Map();
    for (const item of cprCases) {
      tally.set(item.squad, (tally.get(item.squad) ?? 0) + 1);
    }
    buildListSheet(
      workbook,
      '疑似OHCA各分隊件數',
      title,
      ['分隊', '件數'],
      [
        ['合計', cprCases.length],
        ...[...tally].sort((left, right) => right[1] - left[1]
          || left[0].localeCompare(right[0], 'zh-Hant')),
      ],
    ).getRow(3).font = { bold: true };

    buildListSheet(
      workbook,
      '疑似OHCA逐案清單',
      title,
      ['分隊', '案件日期', 'TEMSIS'],
      cprCases.map((item) => [item.squad, item.caseDate, item.temsis]),
    );
  }

  if (overlaps.length > 0) {
    buildListSheet(
      workbook,
      '同時掛兩種類型',
      title,
      ['分隊', '案件日期', 'TEMSIS', '同時出現在'],
      overlaps.map((item) => [item.squad, item.caseDate, item.temsis, item.both]),
    );
  }

  if (probes.length > 0) {
    // 一個欄位一列、一件案子一欄——要比對的是「同一個欄位在兩件之間差在哪」，
    // 橫著排才看得出來。
    const fieldRows = probes[0].values.map((field, index) => [
      field.label,
      ...probes.map((item) => item.values[index]?.value ?? '(讀不到)'),
    ]);
    buildListSheet(
      workbook,
      'OHCA判斷欄位',
      title,
      ['欄位', ...probes.map((item) => `${item.squad}${maskCode(item.temsis)}`)],
      fieldRows,
    );

    buildListSheet(
      workbook,
      '救護紀錄表字樣',
      title,
      ['分隊', 'TEMSIS', '紀錄表字數', '命中字樣（僅供對照，多為印好的欄位標籤）'],
      probes.map((item) => [item.squad, item.temsis, item.length, describeHits(item.hits)]),
      { wideColumns: ['命中字樣（僅供對照，多為印好的欄位標籤）'] },
    );
  }

  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(PATHS.internalDir, `心電圖類型對撞-${monthRange.label}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

/**
 * 跑完整個 OHCA 對撞診斷。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {{temsis?: string[]}} [options] `temsis`＝另外抓這幾件的救護紀錄表來比對字樣
 */
export async function diagnoseOhca(context, page, monthRange, options = {}) {
  log.step('開啟救護紀錄表查詢');
  await gotoRecordQuery(page);

  const { fields, options: ecgOptions } = await resolveEcgOptions(page);
  if (ecgOptions.length < 2) {
    throw new Error('心電圖下拉裡找不到任何 OHCA 選項，無法對撞。請看畫面確認選項文字。');
  }
  const cpr = await locateCprCheckbox(page);

  // 最後多跑一次「12導程 ＋ 處置勾 CPR」：依使用者 2026-08-12 的規則，
  // 這一批就是**掛在 12 導程底下、實際卻是 OHCA** 的案件。
  const queries = [
    ...ecgOptions,
    {
      key: 'twelveLeadWithCpr',
      label: '12導程心電圖（處置勾了CPR）',
      value: fields.twelveLeadValue,
      cprChecked: true,
    },
  ];
  const tables = await exportByEcgType(context, page, monthRange, fields, queries, cpr);
  const twelveLead = tables.get('twelveLead');
  const temsisColumn = resolveColumnByNames(twelveLead.headers, EKG.verify.temsisColumns)?.column;
  if (!temsisColumn) {
    throw new Error(`匯出檔找不到 TEMSIS 欄。實際欄名有：${twelveLead.headers.join('、')}`);
  }
  const squadColumn = resolveSquadColumn(
    twelveLead.headers,
    twelveLead.rows,
    SQUAD_COLUMN_CANDIDATES,
  ).column;
  const caseDateColumn = resolveColumnByNames(twelveLead.headers, UNLOCK.listColumns.caseDate)?.column;

  /** 把一列匯出資料整理成清單要用的三個欄位。 */
  const describeCase = (row) => ({
    temsis: String(row[temsisColumn] ?? '').trim(),
    squad: String(row[squadColumn] ?? '').trim() || '(讀不到分隊)',
    caseDate: caseDateColumn ? String(row[caseDateColumn] ?? '').trim() : '(讀不到)',
  });

  // ---- 一、條件對撞 ----
  log.step('一、同一件案子有沒有同時掛「12導程」與「OHCA」');
  const counts = queries
    .filter((option) => tables.has(option.key))
    .map((option) => ({ label: option.label, count: tables.get(option.key).rows.length }));
  for (const item of counts) log.info(`　${item.label}：${item.count} 件`);

  const overlaps = [];
  for (const option of ecgOptions.slice(1)) {
    const table = tables.get(option.key);
    if (!table) continue;
    const shared = rowsAlsoIn(twelveLead, table, temsisColumn);
    if (shared.length === 0) {
      log.ok(`　沒有案件同時掛著「12導程」與「${option.label}」——這兩種是互斥的`);
      continue;
    }
    log.warn(
      `　有 ${shared.length} 件同時掛著「12導程」與「${option.label}」。`
        + '這些件在正式報表裡是被當成 12 導程算進分母的。',
    );
    for (const row of shared) {
      overlaps.push({ ...describeCase(row), both: `12導程 ＋ ${option.label}` });
    }
  }

  // 兩個 OHCA 選項之間也要對撞一次。
  // ⚠ 2026-08-12 實跑兩邊都剛好是 18 件，光看件數無法確定它們是不是同一批案件
  //   （也就是下拉根本沒換到）。比 TEMSIS 才答得出來。
  const [beforeArrival, afterArrival] = ['beforeArrival', 'afterArrival'].map((key) => tables.get(key));
  if (beforeArrival && afterArrival) {
    const sharedOhca = rowsAlsoIn(beforeArrival, afterArrival, temsisColumn);
    const identical = sharedOhca.length === beforeArrival.rows.length
      && beforeArrival.rows.length === afterArrival.rows.length;
    if (identical) {
      log.warn(
        `　⚠ 兩個 OHCA 選項查出來是**完全同一批案件**（各 ${beforeArrival.rows.length} 件）。`
          + '這代表下拉可能根本沒切換成功，這次的對撞結論不可信，請看畫面確認。',
      );
    } else {
      log.ok(
        `　兩個 OHCA 選項確實是不同批案件（到院前 ${beforeArrival.rows.length} 件、`
          + `到院後 ${afterArrival.rows.length} 件，重疊 ${sharedOhca.length} 件）`,
      );
    }
  }

  // ---- 二、掛 12 導程、但處置勾了 CPR ＝ 實際上是 OHCA ----
  //
  // 使用者 2026-08-12 給的判定規則。這一段才是整支診斷真正要的答案：
  // 前面的類型對撞證明系統裡「12導程」與「OHCA」是互斥的（沒有一件同時掛兩種），
  // 所以誤標不會從那裡看出來——只有從**處置**才看得出來。
  log.step('二、掛「12導程」但處置勾了 CPR 的案件（依你的規則＝實際上是 OHCA）');
  const withCpr = tables.get('twelveLeadWithCpr');
  const cprCases = (withCpr?.rows ?? []).map(describeCase).filter((item) => item.temsis);
  const twelveLeadTotal = twelveLead.rows.length;

  if (cprCases.length === 0) {
    log.ok('　一件都沒有——12 導程那批裡沒有處置勾 CPR 的案件。');
  } else {
    const share = ((cprCases.length / twelveLeadTotal) * 100).toFixed(1);
    log.warn(
      `　有 ${cprCases.length} 件（占 12 導程 ${twelveLeadTotal} 件的 ${share}%）。`
        + '這些目前都被算進分母，但依你的規則它們是 OHCA。',
    );
    const tally = new Map();
    for (const item of cprCases) tally.set(item.squad, (tally.get(item.squad) ?? 0) + 1);
    const listed = [...tally]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hant'))
      .map(([squad, count]) => `${squad} ${count} 件`);
    log.info(`　各分隊：${listed.join('、')}`);
    log.info('　⚠ 這只是「找出來」，沒有動任何報表數字。要不要從分母扣掉由你決定。');
  }

  // ---- 三、救護紀錄表字樣 ----
  const wanted = options.temsis ?? [];
  const probes = [];
  if (wanted.length > 0) {
    log.step(`三、抓 ${wanted.length} 件的救護紀錄表，讀 OHCA 判斷欄位（佐證用）`);
    log.info('⚠ 紀錄表是表單，欄位標籤每張都印著，所以「文字有出現 OHCA」不代表什麼——');
    log.info('　 要看的是那些欄位**填了什麼值**（2026-08-12 實跑證實字樣次數沒有鑑別力）。');
    for (const temsis of wanted) {
      const row = twelveLead.rows.find((item) => String(item[temsisColumn] ?? '').trim() === temsis);
      const squad = row ? String(row[squadColumn] ?? '').trim() : '';
      const probe = await probeRecordSheet(context, page, temsis, squad, monthRange)
        .catch((error) => {
          log.warn(`${maskCode(temsis)}：讀不到紀錄表（${error instanceof Error ? error.message : String(error)}）`);
          return null;
        });
      if (probe) probes.push(probe);
    }

    if (probes.length >= 2) {
      log.step('　欄位值比較（真正有鑑別力的是這個：OHCA 案件才會有值）');
      for (const [index, field] of probes[0].values.entries()) {
        const perCase = probes.map((item) => `${maskCode(item.temsis)}＝${item.values[index]?.value ?? '(讀不到)'}`);
        log.info(`　${field.label}：${perCase.join('　')}`);
      }

      log.step('　字樣次數（留著當對照：值都一樣就代表這些字是印好的標籤，不能拿來判斷）');
      const allMarkers = [...new Set(probes.flatMap((item) => item.hits.map((hit) => hit.marker)))];
      for (const marker of allMarkers) {
        const perCase = probes.map((item) => {
          const hit = item.hits.find((entry) => entry.marker === marker);
          return `${maskCode(item.temsis)}×${hit?.count ?? 0}`;
        });
        log.info(`　${marker}：${perCase.join('　')}`);
      }
    }
    if (probes.length > 0) {
      log.step('　紀錄表上有哪些欄位（表單結構，供決定該用哪一欄判斷）');
      log.info(`　${probes[0].labels.join('｜') || '(一個標籤都讀不到)'}`);
    }
  }

  const filePath = await writeOhcaReport(monthRange, counts, overlaps, probes, cprCases);
  log.ok(`對撞結果已寫出：${path.relative(process.cwd(), filePath)}`);
  log.warn('⚠ 這份含完整 TEMSIS，是內部診斷紀錄，**不要發給分隊**。');
  return { counts, overlaps, cprCases, probes, filePath };
}
