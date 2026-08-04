/**
 * 心電圖流程的診斷指令（`ekg-diag`）——**只查不算，不產生任何報表**。
 *
 * 為什麼要有這一支：2026-08-04 第一次實跑冒出兩個問題，
 * 而伺服器端的登入很快就逾時，每問一件事就要重打一次驗證碼很浪費。
 * 這裡把「要當面問系統的問題」集中在一次登入裡問完：
 *
 *   一、**條件的關係**：EKG檢查與 12 導程心電圖到底是不是包含關係？
 *       實測分母 243 件 < 分子 285 件，量出交集才知道差在哪。
 *   二、**傳輸紀錄到底是什麼**：查詢結果那一列的「傳輸紀錄」按下去沒有反應，
 *       真正拿得到時間的是案件內部的「上傳」。使用者說這兩者可能不同
 *       （傳輸紀錄像是設備自動上傳、上傳可能兩種都含），要兩邊都看過才知道。
 *
 * ⚠ 個資原則：
 *   - 匯出檔只用來數筆數，數完立刻刪除
 *   - 畫面上的表格**只印欄位名稱與「時間／類型」那幾欄的值**，
 *     不印上傳者姓名等其他欄位；TEMSIS 一律只顯示末 4 碼
 */
import fs from 'node:fs/promises';
import { EKG, UNLOCK } from './config.mjs';
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
import { resolveSquadColumn, resolveColumnByNames, countBySquad } from './aggregate.mjs';
import { SQUAD_COLUMN_CANDIDATES } from './config.mjs';

/**
 * 要量的條件組合。
 * 前兩個是正式流程實際用的（重量一次確認可重現），第三個是這次要問的交集。
 */
const COMBINATIONS = [
  { key: 'diag-a', label: 'A　勾EKG檢查　＋　心電圖不限', procedureChecked: true, useTwelveLead: false },
  { key: 'diag-b', label: 'B　不勾EKG檢查　＋　心電圖＝12導程', procedureChecked: false, useTwelveLead: true },
  { key: 'diag-c', label: 'C　勾EKG檢查　＋　心電圖＝12導程（交集）', procedureChecked: true, useTwelveLead: true },
];

/**
 * 在畫面上找出「含心電圖字樣」的列，只印時間與類型欄。
 *
 * ⚠ 個資：`findMarkedRows` 會帶出命中那幾列的儲存格內容，其中含「上傳者」姓名。
 *   這裡**只挑欄名含時間／類型／說明的欄位印出來**，其餘一律不印。
 *
 * @param {string} where 這是哪一個畫面，印在訊息裡
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

/** 一、量各種條件組合的件數。 */
async function measureCombinations(context, page, monthRange) {
  log.step('一、量「EKG檢查」與「12導程心電圖」的關係');
  const fields = await locateEkgFields(page);
  await applyBaseCriteria(page, monthRange);

  /** @type {{label: string, total: number, counts: Map<string, number>}[]} */
  const measured = [];
  for (const combination of COMBINATIONS) {
    const filePath = await queryAndExport(
      context,
      page,
      fields,
      {
        key: combination.key,
        label: combination.label,
        procedureChecked: combination.procedureChecked,
        ecgValue: combination.useTwelveLead ? fields.twelveLeadValue : '',
      },
      monthRange,
    );
    const table = readTable(filePath, SQUAD_COLUMN_CANDIDATES);
    const { column } = resolveSquadColumn(table.headers, table.rows, SQUAD_COLUMN_CANDIDATES);
    measured.push({ label: combination.label, total: table.rows.length, counts: countBySquad(table.rows, column) });
    log.ok(`${combination.label}　→　${table.rows.length} 件`);
    // 匯出檔含個案明細，數完立刻刪。
    await fs.rm(filePath, { force: true });
  }

  const [a, b, c] = measured;
  log.step('條件關係的結論');
  log.info(`A 有做 EKG檢查　　　　　　　${a.total} 件`);
  log.info(`B 有 12 導程心電圖　　　　　${b.total} 件`);
  log.info(`C 兩者都符合（交集）　　　　${c.total} 件`);
  log.info(`→ 有 12 導程、但沒勾 EKG檢查：${b.total - c.total} 件`);
  log.info(`→ 勾了 EKG檢查、但沒有 12 導程：${a.total - c.total} 件`);
  if (c.total === b.total) {
    log.ok('交集等於 B，代表 12 導程確實是 EKG檢查的子集合，原本的分母定義沒問題。');
  } else {
    log.warn(
      `交集比 B 少 ${b.total - c.total} 件，代表**有 12 導程卻沒勾 EKG檢查**的案件確實存在。`
        + '分母要用哪一個是業務定義問題，需要你決定。',
    );
  }

  // 挑差距最大的幾個分隊列出來，方便回系統抽查。
  const gaps = [...b.counts]
    .map(([squad, count]) => ({ squad, gap: count - (c.counts.get(squad) ?? 0) }))
    .filter((item) => item.gap > 0)
    .sort((left, right) => right.gap - left.gap)
    .slice(0, 8);
  if (gaps.length > 0) {
    log.info(`差最多的分隊：${gaps.map((item) => `${item.squad} ${item.gap} 件`).join('、')}`);
  }
  return { fields, sampleCounts: b.counts };
}

/** 二、看清楚「傳輸紀錄」與「上傳」各自是什麼。 */
async function inspectTransmissionAndUpload(context, page, monthRange, temsis) {
  log.step(`二、看清楚「傳輸紀錄」與「上傳」的差別（樣本 TEMSIS ${maskCode(temsis)}）`);

  const rowIndex = await queryByTemsis(page, temsis, monthRange);
  if (rowIndex < 0) {
    log.warn('這筆樣本查不到案件，跳過這一段。');
    return;
  }

  // ---- 傳輸紀錄 ----
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

  // ---- 案件內部的上傳 ----
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
  log.step('心電圖流程診斷（只查不算，不會產生任何報表）');
  log.info('這支指令把「要當面問系統的問題」集中在一次登入裡問完。');

  await gotoRecordQuery(session.page);
  await measureCombinations(session.context, session.page, monthRange);

  // 拿一筆真的有 12 導程的案件當樣本：重新查一次 B 的條件，取第一筆的 TEMSIS。
  log.step('取一筆樣本案件');
  const fields = await locateEkgFields(session.page);
  const samplePath = await queryAndExport(
    session.context,
    session.page,
    fields,
    { key: 'diag-sample', label: '取樣本：12導程心電圖案件', procedureChecked: false, ecgValue: fields.twelveLeadValue },
    monthRange,
  );
  const table = readTable(samplePath, SQUAD_COLUMN_CANDIDATES);
  const temsisColumn = resolveColumnByNames(table.headers, EKG.verify.temsisColumns);
  const sample = temsisColumn
    ? String(table.rows[0]?.[temsisColumn.column] ?? '').trim()
    : '';
  await fs.rm(samplePath, { force: true });

  if (!sample) {
    log.warn('取不到樣本 TEMSIS，第二段跳過。');
    return;
  }
  await inspectTransmissionAndUpload(session.context, session.page, monthRange, sample);

  log.step('診斷完成');
  log.info('以上結果請一併回報，好判斷分母要怎麼定、以及傳輸紀錄要不要一起看。');
  log.info('畫面結構快照存在 out/probe/（只有結構、沒有個案資料）。');
}
