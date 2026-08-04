/**
 * 心電圖流程的診斷指令（`ekg-diag`）——**只查不算，不產生報表**。
 *
 * 為什麼要有這一支：伺服器端的登入很快就逾時，每問一件事就要重打一次驗證碼。
 * 因此把「要當面問系統的問題」集中在一次登入裡問完，而且**同樣的查詢只跑一次**
 * ——每一次查詢＋匯出要花約一分鐘，重複問等於平白讓人多等。
 *
 * 目前回答四個問題：
 *   一、EKG檢查與 12 導程是不是包含關係？（量 A／B／交集）
 *   二、「傳輸紀錄」與「上傳」到底各是什麼？（拿一筆真案件兩邊都走一遍）
 *   三、加上「已結案＋送醫」會差多少？
 *   四、有 12 導程卻沒勾 EKG檢查的那些案件，是什麼情形？
 *
 * ⚠ 個資原則：
 *   - 匯出檔只用來數筆數與比對 TEMSIS，用完立刻刪除
 *   - 畫面上的列只印「時間／類型」欄，不印上傳者姓名
 *   - 產出的清單 TEMSIS 一律只寫末 4 碼
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { EKG, UNLOCK, PATHS, QUERY_CRITERIA, SQUAD_COLUMN_CANDIDATES } from './config.mjs';
import {
  content,
  describeClickableOptions,
  hasCaseDetail,
  openCaseByDispatchNo,
} from './caseFlow.mjs';
import { applyBaseCriteria, locateEkgFields, queryAndExport } from './ekgScrape.mjs';
import { queryByTemsis } from './ekgVerify.mjs';
import { log } from './logger.mjs';
import { gotoRecordQuery } from './navigation.mjs';
import { clickMatch, findClickables, findMarkedRows, listTableHeaders } from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import { extractLabeledValue, maskCode } from './sheetFields.mjs';
import { readTable } from './workbook.mjs';
import { resolveSquadColumn, resolveColumnByNames } from './aggregate.mjs';

/**
 * 要跑的查詢組合。**每一種只跑一次**，後面四段分析共用同一批結果。
 *
 * `strict` 代表加上「救護狀態＝已結案、送醫情形＝送醫」。
 */
const QUERIES = [
  { key: 'A', label: '勾EKG檢查　　　（不限狀態）', procedure: true, twelveLead: false, strict: false },
  { key: 'B', label: '12導程心電圖　（不限狀態）', procedure: false, twelveLead: true, strict: false },
  { key: 'C', label: '兩者都要　　　（不限狀態）', procedure: true, twelveLead: true, strict: false },
  { key: 'A2', label: '勾EKG檢查　　　＋已結案＋送醫', procedure: true, twelveLead: false, strict: true },
  { key: 'B2', label: '12導程心電圖　＋已結案＋送醫', procedure: false, twelveLead: true, strict: true },
];

/** 從一份匯出檔取出 TEMSIS 欄名；找不到就中止並列出實際欄名。 */
function temsisColumnOf(table) {
  const column = resolveColumnByNames(table.headers, EKG.verify.temsisColumns);
  if (!column) {
    throw new Error(`匯出檔找不到 TEMSIS 欄。實際欄名有：${table.headers.join('、')}`);
  }
  return column.column;
}

/**
 * 跑完所有查詢，回傳每一種的資料表。
 *
 * 匯出檔含個案明細，讀進記憶體後**立刻刪檔**；後續分析都在記憶體裡做。
 * @returns {Promise<Map<string, import('./workbook.mjs').TableData>>}
 */
async function runAllQueries(context, page, monthRange) {
  log.step(`跑 ${QUERIES.length} 種查詢（每種約一分鐘，同樣的條件不會問第二次）`);
  const fields = await locateEkgFields(page);
  const tables = new Map();

  for (const query of QUERIES) {
    // 診斷要量「不限」與「加條件」兩種，因此**兩邊都明確指定**，
    // 不靠預設值——預設值哪天改了，這裡量出來的東西就會變成另一件事。
    await applyBaseCriteria(page, monthRange, query.strict
      ? { rescueStatus: QUERY_CRITERIA.rescueStatusValue, transport: QUERY_CRITERIA.transportValue }
      : { rescueStatus: '', transport: '' });
    const filePath = await queryAndExport(
      context,
      page,
      fields,
      {
        key: `diag-${query.key}`,
        label: query.label,
        procedureChecked: query.procedure,
        ecgValue: query.twelveLead ? fields.twelveLeadValue : '',
      },
      monthRange,
    );
    const table = readTable(filePath, SQUAD_COLUMN_CANDIDATES);
    tables.set(query.key, table);
    log.ok(`${query.label}　→　${table.rows.length} 件`);
    await fs.rm(filePath, { force: true });
  }

  await writeExportHeaders([...tables.values()][0]);
  return tables;
}

/**
 * 把匯出檔的欄名存成一份清單。
 *
 * 匯出檔有 240 多欄，欄名跟畫面上的標籤未必一樣；要對應新欄位時
 * 沒有這份清單就只能再登入一次重跑（2026-08-05 為了找「救護狀態」欄就卡在這）。
 *
 * ⚠ 個資：**只有欄位名稱**，不含任何資料列——與探測模式同一個標準。
 */
async function writeExportHeaders(table) {
  if (!table) return;
  await fs.mkdir(PATHS.probeDir, { recursive: true });
  const filePath = path.join(PATHS.probeDir, '匯出檔欄名.txt');
  const body = table.headers.map((header, index) => `[${index}] ${header}`).join('\n');
  await fs.writeFile(filePath, `匯出檔共 ${table.headers.length} 欄\n\n${body}\n`, 'utf8');
  log.info(`匯出檔的欄名已存出：${path.relative(process.cwd(), filePath)}（只有欄名，沒有資料）`);
}

/** 一、EKG檢查與 12 導程是不是包含關係。 */
function reportOverlap(tables) {
  log.step('一、EKG檢查與 12 導程的關係');
  const a = tables.get('A').rows.length;
  const b = tables.get('B').rows.length;
  const c = tables.get('C').rows.length;

  log.info(`A 有做 EKG檢查　　　　　　${a} 件`);
  log.info(`B 有 12 導程心電圖　　　　${b} 件`);
  log.info(`C 兩者都符合（交集）　　　${c} 件`);
  log.info(`→ 有 12 導程、但沒勾 EKG檢查：${b - c} 件`);
  log.info(`→ 勾了 EKG檢查、但沒有 12 導程：${a - c} 件`);
  log.info(`→ 聯集（目前報表的分母）：${a + b - c} 件`);
  if (c === b) {
    log.ok('交集等於 B，12 導程確實是 EKG檢查的子集合。');
  } else {
    log.warn(`交集比 B 少 ${b - c} 件，兩者互有出入，誰都不是誰的子集合。`);
  }
}

/** 三、加上「已結案＋送醫」會差多少。 */
function reportStrictCriteria(tables) {
  log.step('三、加上「救護狀態＝已結案、送醫情形＝送醫」會差多少');
  const pairs = [
    ['勾EKG檢查', 'A', 'A2'],
    ['12導程　　', 'B', 'B2'],
  ];
  let anyDifference = false;
  for (const [name, looseKey, strictKey] of pairs) {
    const loose = tables.get(looseKey).rows.length;
    const strict = tables.get(strictKey).rows.length;
    if (loose !== strict) anyDifference = true;
    log.info(`${name}：不限 ${loose} 件 → 加條件 ${strict} 件（少了 ${loose - strict} 件）`);
  }
  const inUse = EKG.baseCriteria.rescueStatus || EKG.baseCriteria.transport ? '加條件' : '不限';
  log.info(`　目前正式報表用的是：**${inUse}**（設定在 config.mjs 的 EKG.baseCriteria）`);
  if (!anyDifference) {
    log.ok('完全一樣。這些案件本來就都是「已結案且有送醫」，加不加這兩個條件都不影響結果。');
    return;
  }
  log.info('差異的那幾件多半是未結案或未運送——未運送就沒有「送達醫院時間」可比對，');
  log.info('留在母體裡只會變成「無法判定」，因此已改為預設加上條件。');
}

/**
 * 四、把「有 12 導程、卻沒勾 EKG檢查」那批挑出來，看是什麼情形。
 *
 * 依「救護狀態」「送醫情形」交叉分析，多半就能看出成因。
 */
async function reportTwelveLeadOnly(tables, monthRange) {
  log.step('四、有 12 導程、卻沒勾 EKG檢查的案件是什麼情形');
  const ekgTable = tables.get('A');
  const twelveTable = tables.get('B');
  const checked = new Set(
    ekgTable.rows.map((row) => String(row[temsisColumnOf(ekgTable)] ?? '').trim()).filter(Boolean),
  );
  const temsisColumn = temsisColumnOf(twelveTable);
  const onlyTwelveLead = twelveTable.rows.filter(
    (row) => !checked.has(String(row[temsisColumn] ?? '').trim()),
  );
  log.ok(`有 12 導程但沒勾 EKG檢查：${onlyTwelveLead.length} 件`);
  if (onlyTwelveLead.length === 0) return;

  const { column: squadColumn } = resolveSquadColumn(
    twelveTable.headers,
    twelveTable.rows,
    SQUAD_COLUMN_CANDIDATES,
  );
  /** 交叉分析的面向。分隊只用來出清單，不必再列一次分布。 */
  const facets = [];
  for (const [name, candidates, hints] of [
    ['救護狀態', ['救護狀態', '狀態'], ['狀態', '結案', '填寫']],
    ['送醫情形', ['送醫情形', '送醫', '運送'], ['送醫', '運送', '醫院']],
  ]) {
    const column = resolveColumnByNames(twelveTable.headers, candidates);
    if (!column) {
      // 匯出檔有 200 多欄，欄名跟畫面上的標籤未必一樣。
      // 把「名字有點像」的欄位列出來，下次就知道該把哪個欄名加進候選（2026-08-05 實際踩到）。
      const similar = twelveTable.headers.filter(
        (header) => hints.some((hint) => header.includes(hint)),
      );
      log.info(`　（匯出檔沒有「${name}」欄，跳過這一項分析）`);
      log.info(`　　名字相近的欄位有：${similar.join('｜') || '(一個都沒有)'}`);
      continue;
    }
    facets.push({ name, column: column.column });

    const tally = new Map();
    for (const row of onlyTwelveLead) {
      const value = String(row[column.column] ?? '').trim() || '(空白)';
      tally.set(value, (tally.get(value) ?? 0) + 1);
    }
    const shown = [...tally]
      .sort((left, right) => right[1] - left[1])
      .map(([value, count]) => `${value} ${count} 件`)
      .join('、');
    log.info(`　依${name}：${shown}`);
  }

  await writeTwelveLeadOnlyList(onlyTwelveLead, {
    headers: twelveTable.headers,
    squadColumn,
    temsisColumn,
    facets,
  }, monthRange);
}

/**
 * 把「有 12 導程沒勾 EKG檢查」的清單寫成 Excel，供回系統核對。
 * ⚠ TEMSIS 只寫末 4 碼（與待人工確認清單同一個標準）。
 */
async function writeTwelveLeadOnlyList(rows, columns, monthRange) {
  const ExcelJS = (await import('exceljs')).default;
  const caseDateColumn = resolveColumnByNames(columns.headers, UNLOCK.listColumns.caseDate);
  const header = ['分隊', '案件日期', 'TEMSIS末4碼', ...columns.facets.map((facet) => facet.name)];

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('有12導程沒勾EKG');
  sheet.addRow([`${monthRange.label}　有 12 導程心電圖、但急救處置沒勾「EKG檢查」的案件`]);
  sheet.mergeCells(1, 1, 1, header.length);
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.addRow(header).font = { bold: true };

  for (const row of rows) {
    sheet.addRow([
      String(row[columns.squadColumn] ?? '').trim(),
      caseDateColumn ? String(row[caseDateColumn.column] ?? '').trim() : '(讀不到)',
      maskCode(String(row[columns.temsisColumn] ?? '').trim()),
      ...columns.facets.map((facet) => String(row[facet.column] ?? '').trim() || '(空白)'),
    ]);
  }
  header.forEach((name, index) => {
    sheet.getColumn(index + 1).width = Math.max(14, name.length * 2 + 4);
  });

  await fs.mkdir(PATHS.reportDir, { recursive: true });
  const filePath = path.join(PATHS.reportDir, `心電圖-有12導程沒勾EKG-${monthRange.label}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  log.ok(`清單已產出：${path.relative(process.cwd(), filePath)}（TEMSIS 只寫末 4 碼）`);
}

/**
 * 在畫面上找出「含心電圖字樣」的列，只印時間與類型欄。
 *
 * ⚠ 個資：`findMarkedRows` 會帶出命中那幾列的儲存格內容，其中含「上傳者」姓名。
 *   這裡**只挑欄名含時間／類型／說明的欄位印出來**，其餘一律不印。
 */
async function describeEcgRows(page, where) {
  const tables = await listTableHeaders(content(page)).catch(() => []);
  log.info(`　${where}的表格：${tables.join(' ／ ') || '(沒有帶標題的表格)'}`);

  // 用比較寬的字樣去找：這裡就是要看看「除了 12 導程，還有沒有別種寫法」。
  const markers = ['心電圖', 'EKG', '12導程'];
  const found = await findMarkedRows(content(page), markers).catch(() => null);
  if (!found?.rows.length) {
    log.info(`　${where}：找不到任何含「${markers.join('／')}」的列`);
    return;
  }

  const wanted = ['時間', '類型', '說明', '備註'];
  const keepIndexes = found.headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => wanted.some((word) => header.includes(word)));

  log.info(`　${where}：找到 ${found.rows.length} 列（只列時間與類型欄，不印上傳者姓名）`);
  for (const [position, row] of found.rows.entries()) {
    const shown = keepIndexes.length > 0
      ? keepIndexes.map(({ header, index }) => `${header}=${row[index] ?? ''}`).join('　')
      : row.slice(0, 3).join('　');
    log.info(`　　${position + 1}. ${shown}`);
  }
}

/** 二、看清楚「傳輸紀錄」與「上傳」各自是什麼。 */
async function inspectTransmissionAndUpload(context, page, monthRange, temsis) {
  log.step(`二、看清楚「傳輸紀錄」與「上傳」的差別（樣本 TEMSIS ${maskCode(temsis)}）`);

  const rowIndex = await queryByTemsis(page, temsis, monthRange);
  if (rowIndex < 0) {
    log.warn('這筆樣本查不到案件，跳過這一段。');
    return;
  }

  const transmission = await findClickables(content(page), EKG.verify.transmissionButtons)
    .catch(() => []);
  if (transmission.length === 0) {
    log.warn(`查詢結果這一列沒有「${EKG.verify.transmissionButtons[0]}」按鈕。`);
  } else {
    log.info(`按下查詢結果那一列的「${EKG.verify.transmissionButtons[0]}」，看它跑到哪裡`);
    await clickMatch(content(page), EKG.verify.transmissionButtons, transmission[0].index);
    // 這個按鈕會把畫面導走，給它足夠的時間把新頁面載完。
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(EKG.verify.settleMs * 2);

    log.info(`　按下去之後可以點的東西：${await describeClickableOptions(page)}`);
    await describeEcgRows(page, '傳輸紀錄');
    await captureSnapshot(context, '心電圖診斷-傳輸紀錄');
  }

  log.info('接著走案件內部的「上傳」，兩邊對照');
  const backIndex = await queryByTemsis(page, temsis, monthRange);
  if (backIndex < 0) {
    log.warn('回不到查詢結果，「上傳」那一段跳過。');
    return;
  }
  const sheet = await openRecordSheet(
    context,
    content(page),
    UNLOCK.buttonTexts.openRecordSheet,
    backIndex,
  );
  const dispatchNo = extractLabeledValue(sheet.text, UNLOCK.sheetLabels.dispatchNo, {
    maxLength: 24,
    singleToken: true,
  });
  if (!dispatchNo?.value) {
    log.warn('紀錄表上讀不到指派案號，進不了案件內部。');
    return;
  }
  await openCaseByDispatchNo(context, page, dispatchNo.value, monthRange);

  for (const [buttonTexts, label] of [
    [EKG.verify.transmissionButtons, '案件內部的「傳輸紀錄」'],
    [EKG.verify.uploadButtons, '案件內部的「上傳」'],
  ]) {
    const found = await findClickables(content(page), buttonTexts).catch(() => []);
    if (found.length === 0) {
      log.info(`　${label}：這一頁沒有這個按鈕`);
      continue;
    }
    await clickMatch(content(page), buttonTexts, found[0].index);
    await page.waitForTimeout(EKG.verify.settleMs * 2);
    await describeEcgRows(page, label);
    await captureSnapshot(context, `心電圖診斷-${label}`);
    if (!(await hasCaseDetail(page))) {
      await openCaseByDispatchNo(context, page, dispatchNo.value, monthRange);
    }
  }
}

/**
 * 診斷主流程。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 */
export async function runEkgDiagnose(session, monthRange) {
  log.step('心電圖流程診斷（只查不算，不會產生報表）');

  await gotoRecordQuery(session.page);
  const tables = await runAllQueries(session.context, session.page, monthRange);

  reportOverlap(tables);
  reportStrictCriteria(tables);
  await reportTwelveLeadOnly(tables, monthRange);

  // 樣本直接取自已經抓回來的 12 導程那一份，不必為了拿一個編號再查一次。
  const twelveTable = tables.get('B');
  const sample = String(twelveTable.rows[0]?.[temsisColumnOf(twelveTable)] ?? '').trim();
  if (sample) {
    await inspectTransmissionAndUpload(session.context, session.page, monthRange, sample);
  } else {
    log.warn('取不到樣本 TEMSIS，「傳輸紀錄 vs 上傳」那一段跳過。');
  }

  log.step('診斷完成');
  log.info('畫面結構快照存在 out/probe/（只有結構、沒有個案資料）。');
}
