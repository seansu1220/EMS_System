/**
 * 逐案查核：12 導程心電圖到底是不是在**到院之前**就傳出去了。
 *
 * 系統的「12導程心電圖」查詢只告訴你有做，不告訴你什麼時候傳出去的。
 * 使用者的人工作法是一件一件點開看，這裡把同一套流程自動化：
 *
 *   1. 以 TEMSIS 查回該筆案件
 *   2. 取得**到院時間**（依序試：匯出檔的欄 → 查詢結果那一列 → 救護紀錄表 PDF）
 *   3. 取得**12 導程的上傳時間**（依序試：查詢結果列的「傳輸紀錄」→
 *      案件內部的「傳輸紀錄」→ 案件內部的「上傳」）
 *   4. 上傳早於到院 → 這件算數；晚於到院 → 不算；看不出來 → 列入人工確認清單
 *
 * ⚠ 這個流程很慢（每件要開好幾個畫面），因此：
 *   - **每完成一件就寫一次進度檔**，中途失敗或關掉視窗都不必從頭跑
 *   - 連續失敗到一定件數就中止，不讓改版後的錯誤跑滿兩小時
 *   - 可用 `--limit=N` 先試跑幾件，確認判斷正確再跑整個月
 *
 * ⚠ 個資原則：
 *   - 進度檔含 TEMSIS（續跑必需），只落在 `out/raw/`，與匯出明細一起刪除
 *   - 畫面與紀錄檔上的 TEMSIS 一律只顯示末 4 碼（`maskCode`）
 *   - 只從畫面取出「時間」這一種值，紀錄表全文用完即棄、不落檔
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { EKG, PATHS, UNLOCK } from './config.mjs';
import {
  content,
  applyDateRange,
  applyTextCondition,
  findClickablesWithRetry,
  describeClickableOptions,
  submitQuery,
  pickFirstValue,
  openCaseByDispatchNo,
} from './caseFlow.mjs';
import { log } from './logger.mjs';
import { gotoRecordQuery } from './navigation.mjs';
import {
  clickMatch,
  findClickables,
  findRowsWithColumnValue,
  groupByRow,
  listTableHeaders,
  readRowFields,
} from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import { extractLabeledValue, maskCode } from './sheetFields.mjs';
import { parseDateTime, findFirstDateTime, compareUploadToArrival } from './timeParse.mjs';

/**
 * @typedef {Object} EkgCase
 * @property {string} temsis 要查回系統的 TEMSIS
 * @property {string} squad  出勤單位（分隊）
 * @property {string} arrivalText 匯出檔上的到院時間原文（沒有這一欄時為空字串）
 */

/**
 * @typedef {Object} VerifyOutcome
 * @property {string} temsis
 * @property {string} squad
 * @property {'到院前'|'到院後'|'無法判定'} verdict
 * @property {string} reason 判定依據，寫給人看
 * @property {string|null} arrival 讀到的到院時間原文
 * @property {string|null} upload  讀到的上傳時間原文
 * @property {string} source 上傳時間是從哪個畫面讀到的
 * @property {string|null} [caseDate] 案件日期。判定不出來的案件要靠它才找得回原案
 */

/** 判定結果的三種值，集中定義避免各處字串打錯。 */
export const VERDICT = { before: '到院前', after: '到院後', unknown: '無法判定' };

/**
 * 已經留過診斷的按鈕。
 *
 * 某個按鈕按下去沒反應時，第一次要把「跑到哪一頁、那頁有什麼」記下來；
 * 但跑幾百件的話每一件的情形都一樣，全部存下來只會把 out/probe/ 塞爆。
 */
const diagnosedButtons = new Set();

/** 進度檔路徑（與匯出明細同層，統計後一起刪除）。 */
export function progressFilePath(monthRange) {
  return path.join(PATHS.rawDir, `${monthRange.label}-ekg-verify-progress.json`);
}

/**
 * 讀取上一次跑到哪裡。
 * 檔案不存在或壞掉都當成「沒有進度」——續跑是加分功能，不該因此讓整個流程掛掉。
 *
 * @returns {Promise<Map<string, VerifyOutcome>>} TEMSIS → 已完成的結果
 */
export async function loadProgress(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter((item) => item?.temsis).map((item) => [item.temsis, item]));
  } catch {
    return new Map();
  }
}

/** 把目前進度寫回檔案（每完成一件就寫一次）。 */
async function saveProgress(filePath, done) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify([...done.values()], null, 2), 'utf8');
}

/**
 * 判斷「這一欄的內容看起來是不是日期時間」所需的比例。
 * 到院時間偶爾會空白（未送醫、資料未填），故不要求 100%。
 */
const DATETIME_CONTENT_THRESHOLD = 0.7;

/**
 * 找出分子匯出檔中「TEMSIS」與「到院時間」兩欄。
 *
 * TEMSIS 是逐案查核的鑰匙（沒有它就無法一件一件查回系統），**找不到就中止**，
 * 並把實際欄名列進錯誤訊息（欄名屬檔案結構，非個人資料）供調整設定。
 *
 * 到院時間則是「有更好、沒有也能跑」：找不到就改從查詢結果那一列或紀錄表 PDF 讀，
 * 只是每一件都要多開一個畫面、慢很多，因此找不到時會提醒。
 *
 * @param {import('./workbook.mjs').TableData} table
 * @param {(headers: string[], candidates: readonly string[]) => {column: string, reason: string}|null} resolveByNames
 * @returns {{temsis: string, arrival: string|null, notes: string[]}}
 */
export function resolveEkgColumns(table, resolveByNames) {
  const temsis = resolveByNames(table.headers, EKG.verify.temsisColumns);
  if (!temsis) {
    throw new Error(
      `匯出檔中找不到 TEMSIS 欄（試過：${EKG.verify.temsisColumns.join('、')}），無法逐案查核。`
        + `實際欄名有：${table.headers.join('、')}。`
        + '請把正確欄名加進 config.mjs 的 EKG.verify.temsisColumns。',
    );
  }

  const notes = [`TEMSIS 欄判定為「${temsis.column}」（${temsis.reason}）`];

  const arrivalByName = resolveByNames(table.headers, EKG.verify.arrivalLabels);
  let arrival = null;
  if (arrivalByName) {
    // 只憑欄名不夠：可能命中「到院時間填寫人」這種欄。實際看內容解不解析得出時間才算數。
    const values = table.rows.map((row) => String(row[arrivalByName.column] ?? '').trim()).filter(Boolean);
    const parsable = values.filter((value) => parseDateTime(value, {})).length;
    const ratio = values.length === 0 ? 0 : parsable / values.length;
    if (ratio >= DATETIME_CONTENT_THRESHOLD) {
      arrival = arrivalByName.column;
      notes.push(`到院時間欄判定為「${arrival}」（${(ratio * 100).toFixed(0)}% 的值解析得出時間）`);
    } else {
      notes.push(
        `欄名像到院時間的「${arrivalByName.column}」只有 ${(ratio * 100).toFixed(0)}% 的值解析得出時間，`
          + '不採用，改為逐案從查詢結果或紀錄表讀取（會比較慢）',
      );
    }
  } else {
    notes.push('匯出檔沒有到院時間欄，改為逐案從查詢結果或紀錄表讀取（會比較慢）');
  }

  return { temsis: temsis.column, arrival, notes };
}

/**
 * 從匯出檔的一列組出待查核案件。
 *
 * @param {Record<string, unknown>[]} rows 匯出檔資料列
 * @param {{temsis: string, squad: string, arrival: string|null}} columns 各欄的欄名
 * @returns {EkgCase[]}
 */
export function buildCaseList(rows, columns) {
  return rows
    .map((row) => ({
      temsis: String(row[columns.temsis] ?? '').trim(),
      squad: String(row[columns.squad] ?? '').trim(),
      arrivalText: columns.arrival ? String(row[columns.arrival] ?? '').trim() : '',
    }))
    .filter((item) => item.temsis && item.squad);
}

/**
 * 點一個按鈕，然後把「含指定字樣的表格列」找出來。
 *
 * 這個系統的畫面有兩種行為：另開視窗、或把原本的 frame 整個換掉。
 * 兩種都要接得住，因此**新視窗與原畫面都會找**，先找到哪邊就用哪邊。
 *
 * @param {string[]} buttonTexts 要點的按鈕文字
 * @param {number} index 第幾個符合的按鈕
 * @param {(frame: import('playwright-core').Frame) => Promise<{matched: object[], headers: string[]}|null>} probe
 *   在某個 frame 上找目標列的方式。之所以做成可注入：上傳清單要比對「檔案類型欄的值」，
 *   而其他畫面可能要用別的規則，把規則交給呼叫端決定，這裡只負責「點下去、等內容出現」。
 * @returns {Promise<{matched: object[], headers: string[], where: string}|null>}
 *   找不到目標列時回傳 null
 */
async function openPanelRows(context, page, buttonTexts, index, probe) {
  /**
   * 按下去**之前**先看原畫面本來就有哪些「含 12 導程」的列。
   *
   * ⚠ 這是實跑（2026-08-04）踩到的坑，不加這一段整批案件都會判定失敗：
   * 查詢條件區裡本來就有一個寫著「12導程心電圖」的勾選框，
   * 它所在的那一列當然含有「12導程」四個字，於是點完傳輸紀錄後的「原畫面」檢查
   * 立刻命中那一列，程式以為找到傳輸紀錄了——但查詢條件那一列根本沒有時間，
   * 結果就是每一件都回報「讀不到 12 導程的上傳時間」，而且完全看不出原因。
   *
   * 因此原畫面的比對結果**必須與按下去之前不同**才算數。
   */
  const baseline = await probe(content(page)).catch(() => null);
  const signatureOf = (found) => JSON.stringify(found?.matched ?? []);
  const baselineSignature = signatureOf(baseline);
  if (baseline?.matched.length) {
    log.info(
      `（原畫面本來就有 ${baseline.matched.length} 列符合，多半是查詢條件區的元件，`
        + '之後只認「按下去之後才變出來的」列）',
    );
  }

  /** @type {import('playwright-core').Page[]} */
  const opened = [];
  const onNewPage = (newPage) => opened.push(newPage);
  /** 系統用 alert／confirm 擋下時的訊息（已遮蔽長數字）。 */
  let blockedMessage = null;
  const onDialog = async (dialog) => {
    blockedMessage = dialog.message().replace(/\d{5,}/g, '#####').slice(0, 80);
    log.warn(`系統跳出訊息：「${blockedMessage}」`);
    // 維持預設的「取消」：這裡只是唯讀地看紀錄，按確定可能觸發沒預期的動作。
    await dialog.dismiss().catch(() => {});
  };

  context.on('page', onNewPage);
  page.on('dialog', onDialog);
  try {
    const clicked = await clickMatch(content(page), buttonTexts, index);
    if (!clicked) {
      log.info(`點不到「${buttonTexts[0]}」（按鈕在點擊當下消失了）`);
      return null;
    }

    /** 找到時把來源與欄位記下來：欄名屬畫面結構，是日後對不上欄位時唯一的線索。 */
    const describe = (found, where) => {
      log.info(
        `找到 ${found.matched.length} 列符合（來源：${where}），`
          + `欄位：${found.headers.join('｜') || '(這張表沒有標題列)'}`,
      );
      return { ...found, where };
    };

    const deadline = Date.now() + EKG.verify.panelTimeoutMs;
    while (Date.now() < deadline) {
      // 先看新視窗（傳輸紀錄多半是彈出視窗），再看原本的內容框（有些是就地換頁）。
      for (const candidate of opened) {
        if (candidate.isClosed()) continue;
        await candidate.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        for (const frame of candidate.frames()) {
          const found = await probe(frame).catch(() => null);
          if (found?.matched.length) return describe(found, '另開的視窗');
        }
      }
      const inPlace = await probe(content(page)).catch(() => null);
      // 與按下去之前一模一樣＝畫面根本沒變，命中的是查詢條件區那一列，不是目標畫面。
      if (inPlace?.matched.length && signatureOf(inPlace) !== baselineSignature) {
        return describe(inPlace, '原本的畫面（按下去之後才出現）');
      }

      // 系統已經明說開不了，再等下去也不會有內容。
      if (blockedMessage) return null;
      await page.waitForTimeout(500);
    }
    log.info(
      `按了「${buttonTexts[0]}」但 ${EKG.verify.panelTimeoutMs / 1000} 秒內沒有出現符合的新內容`
        + `（新視窗 ${opened.length} 個）`,
    );
    // 按了卻沒東西，最想知道的是「那到底跑到哪一頁、那一頁長什麼樣」。
    // 只在**第一次**留診斷：跑幾百件時每件都存一份會把 out/probe/ 塞爆，而每一件的情形都一樣。
    if (!diagnosedButtons.has(buttonTexts[0])) {
      diagnosedButtons.add(buttonTexts[0]);
      log.info(`　按下去之後的畫面：${await describeClickableOptions(page)}`);
      const tables = await listTableHeaders(content(page)).catch(() => []);
      log.info(`　那一頁的表格欄位：${tables.join(' ／ ') || '(沒有帶標題的表格)'}`);
      await captureSnapshot(context, `心電圖-按了${buttonTexts[0]}沒反應`);
    }
    return null;
  } finally {
    context.off('page', onNewPage);
    page.off('dialog', onDialog);
    // 看完立刻關閉，畫面上不留個案明細。
    for (const openedPage of opened) await openedPage.close().catch(() => {});
  }
}

/**
 * 從命中的那幾列裡挑出上傳時間。
 *
 * 一件案子可能傳過好幾次（重傳、補傳），此時取**最早**的那一次：
 * 只要曾經在到院前傳出去過，就算有做到到院前傳輸。
 *
 * @param {{headers: string[], rows: string[][]}} panel
 * @param {{defaultYear?: number, defaultDate?: string}} timeContext
 * @returns {{time: import('./timeParse.mjs').ParsedTime, from: string}|null}
 */
export function pickEarliestUploadTime(matched, timeContext, timeLabels = EKG.verify.uploadTimeLabels) {
  /** @type {{time: import('./timeParse.mjs').ParsedTime, from: string}[]} */
  const found = [];
  for (const row of matched ?? []) {
    const values = row?.values ?? {};
    // ⚠ 迴圈要以**候選字樣**為外層，不是以欄位順序為外層：
    //   設定檔把 `上傳時間` 排在 `建立時間`、`時間` 前面就是為了讓它優先。
    //   若照欄位順序找，排在前面的「建立時間」欄會先命中而取到錯的時間
    //   （建立與上傳可能差好幾十分鐘，剛好跨過到院時間就整件判反）。
    let picked = null;
    for (const label of timeLabels) {
      const parsed = parseDateTime(values[label], timeContext);
      if (parsed) {
        picked = { time: parsed, from: `「${label}」欄` };
        break;
      }
    }
    // 欄名對不上時，退回「這一列取回來的值裡第一個看得懂的時間」。
    picked ??= (() => {
      const fallback = findFirstDateTime(Object.values(values), timeContext);
      return fallback ? { time: fallback, from: '該列第一個看得懂的時間' } : null;
    })();
    if (picked) found.push(picked);
  }
  if (found.length === 0) return null;
  return found.reduce((earliest, item) => (item.time.epochMs < earliest.time.epochMs ? item : earliest));
}

/**
 * 開一次救護紀錄表，同時取得指派案號與到院時間。
 *
 * 兩個值都要用到，開兩次 PDF 太浪費（每次都是幾秒鐘的網路往返），故一次讀完。
 *
 * @returns {Promise<{dispatchNo: string|null, arrivalText: string|null}>}
 */
async function readSheetInfo(context, page, index) {
  const sheet = await openRecordSheet(context, content(page), UNLOCK.buttonTexts.openRecordSheet, index);
  const dispatchNo = extractLabeledValue(sheet.text, UNLOCK.sheetLabels.dispatchNo, {
    maxLength: 24,
    singleToken: true,
  });
  // 到院時間的值含空白（`2026/07/02 12:44`），不能開 singleToken，否則只會取到日期那一段。
  const arrival = extractLabeledValue(sheet.text, EKG.verify.arrivalLabels, { maxLength: 24 });
  log.info(`紀錄表已讀取（${sheet.kind}／${sheet.source}），共 ${sheet.text.length} 個字元`);
  return { dispatchNo: dispatchNo?.value ?? null, arrivalText: arrival?.value ?? null };
}

/**
 * 後備路線：從「傳輸紀錄」的生命徵象表取心電圖的量測時間。
 *
 * 只有在案件內部的「上傳」清單裡找不到 12 導程時才會走到這裡
 * （使用者 2026-08-04 決定的順序）。
 *
 * 這張表與上傳清單的結構完全不同：EKG 是**欄位標題**、資料列裡是量測數值，
 * 因此要找的是「EKG 這一欄有值的列」，而不是「內容含 12導程 的列」。
 *
 * ⚠ 取到的是**量測時間**（什麼時候量的），不是傳出去的時間，兩者語意不同，
 *   因此回傳值的 `from` 會明說來源，讓使用者在待確認清單上看得出來。
 *
 * @param {string} temsis 要重新查回案件用（按傳輸紀錄會把畫面導走）
 * @returns {Promise<{time: import('./timeParse.mjs').ParsedTime, from: string}|null>}
 */
async function readTransmissionEkgTime(context, page, temsis, range, timeContext) {
  // 現在人在案件內部，傳輸紀錄只存在於查詢結果那一列，得先回去。
  const rowIndex = await queryByTemsis(page, temsis, range);
  if (rowIndex < 0) {
    log.info('回不到查詢結果，傳輸紀錄這條後備路線跳過');
    return null;
  }
  const buttons = await findClickables(content(page), EKG.verify.transmissionButtons).catch(() => []);
  if (buttons.length === 0) {
    log.info(`查詢結果這一列沒有「${EKG.verify.transmissionButtons[0]}」按鈕`);
    return null;
  }

  const clicked = await clickMatch(content(page), EKG.verify.transmissionButtons, buttons[0].index);
  if (!clicked) return null;
  // 這個按鈕是就地換頁（不是彈出視窗），等頁面載完即可。
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(EKG.verify.settleMs);

  const found = await findRowsWithColumnValue(
    content(page),
    EKG.verify.transmissionEkgColumns,
    EKG.verify.transmissionTimeLabels,
  ).catch(() => null);
  if (!found?.matched.length) {
    log.info(
      `傳輸紀錄裡沒有「${EKG.verify.transmissionEkgColumns[0]}」欄有值的列`
        + `（該表欄位：${found?.headers.join('｜') || '讀不到'}）`,
    );
    return null;
  }

  // 量過好幾次時取最早的一次，與上傳清單的規則一致（共用同一支挑選函式）。
  const earliest = pickEarliestUploadTime(found.matched, timeContext, EKG.verify.transmissionTimeLabels);
  if (!earliest) {
    log.info(`傳輸紀錄有 ${found.matched.length} 列做了心電圖，但那幾列讀不出時間`);
    return null;
  }
  log.info(`傳輸紀錄：${found.matched.length} 列有心電圖，最早的量測時間 ${earliest.time.matched}`);
  return { time: earliest.time, from: '傳輸紀錄的「量測時間」（不是上傳時間）' };
}

/**
 * 以 TEMSIS 查回案件，回傳結果那一列上「救護紀錄PDF」按鈕的序號。
 *
 * 抽成函式是為了能**再查一次**：有些按鈕按下去不是另開視窗，而是把畫面整個換掉
 * （第 2 章實測過這種行為），這時原本那一列的按鈕就不見了，後面每一步都會連環失敗。
 *
 * @returns {Promise<number>} 按鈕序號；查無案件時回傳 -1
 */
export async function queryByTemsis(page, temsis, range) {
  await gotoRecordQuery(page);
  await applyDateRange(page, range);
  await applyTextCondition(page, UNLOCK.fieldLabels.temsis, temsis, 'TEMSIS');
  await submitQuery(page);

  const rows = groupByRow(await findClickablesWithRetry(page, UNLOCK.buttonTexts.openRecordSheet));
  return rows.length === 0 ? -1 : rows[0][0].index;
}

/**
 * 查核一件案子。
 *
 * @param {EkgCase} target
 * @param {{defaultYear: number}} timeContext
 * @returns {Promise<VerifyOutcome>}
 */
async function verifyOneCase(context, page, target, range, timeContext) {
  const base = { temsis: target.temsis, squad: target.squad };

  const rowIndex = await queryByTemsis(page, target.temsis, range);
  if (rowIndex < 0) {
    /**
     * ⚠ 這裡**丟例外讓上層重試**，不可以直接判成「無法判定」。
     *
     * 這個 TEMSIS 是從**同一次匯出檔**拿出來的，系統裡一定有這件案子。
     * 查不到幾乎都是查詢頁還沒換完就被送出、條件被洗掉（第 1.8 節那個坑）。
     *
     * 舊版直接回傳「可能已被修改或刪除」，於是暫時性失敗變成永久結論——
     * 2026-08-10 實跑一次就有 4 件這樣，使用者回系統一查全都在，
     * 而那句理由還把人引去查「案件是不是被刪了」，方向完全錯。
     */
    throw new Error('以 TEMSIS 查不到案件（查詢頁可能還沒就緒，稍後重試）');
  }

  // ---- 到院時間：匯出檔 → 查詢結果那一列 → 救護紀錄表 PDF，由便宜到昂貴依序試 ----
  let arrivalText = target.arrivalText || null;
  if (!parseDateTime(arrivalText, timeContext)) {
    const listRow = await readRowFields(
      content(page),
      UNLOCK.buttonTexts.openRecordSheet,
      rowIndex,
      EKG.verify.arrivalLabels,
    ).catch(() => null);
    arrivalText = pickFirstValue(listRow, EKG.verify.arrivalLabels) ?? arrivalText;
  }

  // 到院時間只有時分時，要靠案件日期補齊日期才比得出先後。
  const caseDateRow = await readRowFields(
    content(page),
    UNLOCK.buttonTexts.openRecordSheet,
    rowIndex,
    UNLOCK.listColumns.caseDate,
  ).catch(() => null);
  const caseDate = pickFirstValue(caseDateRow, UNLOCK.listColumns.caseDate);
  const parsedCaseDate = parseDateTime(caseDate, timeContext);
  const localContext = {
    ...timeContext,
    defaultDate: parsedCaseDate ? new Date(parsedCaseDate.epochMs).toISOString().slice(0, 10) : undefined,
  };

  // ---- 上傳時間：先走案件內部的「上傳」（使用者 2026-08-04 決定的優先順序） ----
  //
  // 為什麼上傳優先：實測那是唯一直接寫著「上傳時間 ＋ 檔案類型＝12導程心電圖」的地方，
  // 而且設備自動傳的檔案也會進到這份清單（備註寫著「ZOLL介接心電圖」）。
  // 查詢結果那一列的「傳輸紀錄」其實是**生命徵象量測表**，時間欄叫「量測時間」
  // （量的時間 ≠ 傳出去的時間），語意較弱，因此只當後備。
  const sheetInfo = await readSheetInfo(context, page, rowIndex);
  if (!parseDateTime(arrivalText, localContext) && sheetInfo.arrivalText) {
    arrivalText = sheetInfo.arrivalText;
  }
  if (!sheetInfo.dispatchNo) {
    return {
      ...base,
      verdict: VERDICT.unknown,
      reason: '紀錄表上讀不到指派案號，進不了案件內部',
      arrival: arrivalText,
      upload: null,
      source: '讀不到指派案號',
      caseDate,
    };
  }
  await openCaseByDispatchNo(context, page, sheetInfo.dispatchNo, range);

  let upload = null;
  let source = '';
  const uploadButtons = await findClickables(content(page), EKG.verify.uploadButtons).catch(() => []);
  log.info(`案件內部的「上傳」：${uploadButtons.length === 0 ? '這一頁沒有這個按鈕' : '點進去看'}`);
  if (uploadButtons.length > 0) {
    const panel = await openPanelRows(
      context,
      page,
      EKG.verify.uploadButtons,
      uploadButtons[0].index,
      // 只認「檔案類型」欄寫著 12導程 的列（使用者 2026-08-05 指正）。
      // 比對整列文字的話，備註欄的「ZOLL12導程附檔上傳(JSON檔)」也會命中。
      (frame) => findRowsWithColumnValue(
        frame,
        EKG.verify.fileTypeColumns,
        [...EKG.verify.uploadTimeLabels, ...EKG.verify.fileTypeColumns],
        { valueMarkers: EKG.verify.twelveLeadMarkers },
      ),
    );
    if (panel) {
      upload = pickEarliestUploadTime(panel.matched, localContext);
      if (upload) source = `案件內部的「上傳」（${panel.where}）`;
    }
  }

  // ---- 上傳清單裡沒有 12 導程，才回頭查傳輸紀錄的 EKG 欄 ----
  if (!upload) {
    log.info(`上傳清單裡沒有「${EKG.verify.twelveLeadMarkers[0]}」，回頭查傳輸紀錄`);
    const transmission = await readTransmissionEkgTime(context, page, target.temsis, range, localContext);
    if (transmission) {
      upload = transmission;
      source = '查詢結果的「傳輸紀錄」（EKG 欄的量測時間）';
    }
  }

  if (!upload) {
    await captureSnapshot(context, '心電圖-找不到上傳時間');
    return {
      ...base,
      verdict: VERDICT.unknown,
      reason: '案件內部的「上傳」與查詢結果的「傳輸紀錄」都找不到 12 導程的時間。'
        + await describeClickableOptions(page),
      arrival: arrivalText,
      upload: null,
      source: '兩邊都找不到',
      caseDate,
    };
  }

  const arrival = parseDateTime(arrivalText, localContext);
  const { verdict, reason } = compareUploadToArrival(upload?.time ?? null, arrival);
  return {
    ...base,
    verdict,
    reason: upload ? `${reason}（上傳時間取自${upload.from}）` : reason,
    arrival: arrivalText,
    upload: upload?.time.matched ?? null,
    source: source || '未知',
    caseDate,
  };
}

/**
 * 查核一件，失敗就重試。
 *
 * 為什麼需要：2026-08-04 跑完整月 285 件，8 件判定不出來，其中 **6 件是暫時性失敗**——
 * 「找不到查詢按鈕」「連結在點擊當下消失」「紀錄表 60 秒沒開出來」。
 * 這些是前一件收尾時畫面停在奇怪的位置、或頁面還在換就被點，重跑一次就會過。
 * 讓它們變成要人工核對的案件既浪費使用者的時間，也會低估分子。
 *
 * **只重試「跑到一半出錯」的情況**；程式好好跑完並判定為「到院後」的結果是結論，
 * 不是失敗，重跑幾次都一樣，不重試。
 *
 * ⚠ 「以 TEMSIS 查不到案件」**算失敗、要重試**（2026-08-10 改）：
 * 待查核的 TEMSIS 全部來自同一次匯出檔，系統裡一定有，查不到就是畫面沒就緒。
 *
 * @returns {Promise<VerifyOutcome>}
 */
async function verifyWithRetry(session, target, monthRange, timeContext) {
  const base = { temsis: target.temsis, squad: target.squad };
  let lastError = '';

  for (let attempt = 1; attempt <= EKG.verify.maxAttemptsPerCase; attempt += 1) {
    try {
      return await verifyOneCase(session.context, session.page, target, monthRange, timeContext);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < EKG.verify.maxAttemptsPerCase) {
        log.warn(`第 ${attempt} 次查核出錯（${lastError}），重試`);
        // 重試前先讓畫面沉澱一下：多數失敗是頁面還在換就被點。
        await session.page.waitForTimeout(EKG.verify.settleMs);
      }
    }
  }

  log.warn(`重試 ${EKG.verify.maxAttemptsPerCase} 次都失敗，記為需人工確認`);
  return {
    ...base,
    verdict: VERDICT.unknown,
    reason: `查核過程出錯（已重試 ${EKG.verify.maxAttemptsPerCase} 次）：${lastError}`,
    arrival: target.arrivalText || null,
    upload: null,
    source: '執行失敗',
    caseDate: null,
  };
}

/**
 * 逐案查核整批案件。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {EkgCase[]} cases
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {{limit?: number}} [options] `limit`＝只查核前幾件（先試跑用）
 * @returns {Promise<{outcomes: VerifyOutcome[], skipped: number, aborted: boolean}>}
 */
export async function verifyEkgCases(session, cases, monthRange, options = {}) {
  // 只有月日的時間（紀錄表 PDF 上常見）要靠查詢月份的年份才補得齊。
  const timeContext = { defaultYear: Number(monthRange.start.slice(0, 4)) };
  const filePath = progressFilePath(monthRange);
  const done = await loadProgress(filePath);

  const planned = typeof options.limit === 'number' ? cases.slice(0, options.limit) : cases;
  const skipped = cases.length - planned.length;

  // 進度是以 TEMSIS 當索引鍵的，重複的話後面那筆會蓋掉前面那筆而讓分子少算。
  // TEMSIS 照理是一筆一個，真的重複代表匯出檔或欄位判定有問題，要講出來。
  const duplicates = planned.length - new Set(planned.map((item) => item.temsis)).size;
  if (duplicates > 0) {
    log.warn(
      `待查核清單裡有 ${duplicates} 筆重複的 TEMSIS，重複的只會算一次，分子可能少算。`
        + '請確認匯出檔的 TEMSIS 欄是不是抓對了欄位。',
    );
  }

  log.step(`逐案查核 12 導程的上傳時間（共 ${planned.length} 件）`);
  if (done.size > 0) {
    log.ok(`接續上次的進度：已完成 ${done.size} 件，這次只跑沒做過的`);
  }
  if (skipped > 0) {
    log.warn(`依 --limit 只查核前 ${planned.length} 件，其餘 ${skipped} 件未查核（不會計入分子）`);
  }
  log.info('每完成一件都會存檔，中途關掉視窗也不必從頭再跑一次。');

  let consecutiveFailures = 0;
  let aborted = false;
  for (const [position, target] of planned.entries()) {
    if (done.has(target.temsis)) continue;

    log.step(`第 ${position + 1} / ${planned.length} 件：${target.squad}　${maskCode(target.temsis)}`);
    const outcome = await verifyWithRetry(session, target, monthRange, timeContext);
    done.set(target.temsis, outcome);
    consecutiveFailures = outcome.verdict === VERDICT.unknown ? consecutiveFailures + 1 : 0;
    log[outcome.verdict === VERDICT.before ? 'ok' : 'warn'](`${outcome.verdict}：${outcome.reason}`);
    // 每一件都存檔：跑幾百件的流程，任何一次中斷都不該讓前面的努力白費。
    await saveProgress(filePath, done).catch((error) => {
      log.warn(`進度存檔失敗（不影響本次結果）：${error instanceof Error ? error.message : String(error)}`);
    });

    if (consecutiveFailures >= EKG.verify.abortAfterConsecutiveFailures) {
      log.warn(
        `連續 ${consecutiveFailures} 件都判定不出來，先停下來讓你看錯誤訊息`
          + '（畫面可能已改版）。已完成的進度都留著，修好之後再跑一次會從這裡接著跑。',
      );
      aborted = true;
      break;
    }
    await session.page.waitForTimeout(EKG.verify.settleMs);
  }

  // 只回傳這次計畫要跑的那些案件的結果，避免上次進度檔裡的舊案件混進來。
  const plannedKeys = new Set(planned.map((item) => item.temsis));
  return {
    outcomes: [...done.values()].filter((item) => plannedKeys.has(item.temsis)),
    skipped,
    aborted,
  };
}

/**
 * 把查核結果彙總成「各分隊確認在到院前傳出去的件數」。
 *
 * **只有判定為「到院前」的才計入**：判定為到院後的不算（使用者的規則），
 * 無法判定的也不算，改列入人工確認清單（使用者 2026-08-03 選擇的處理方式）。
 *
 * @param {VerifyOutcome[]} outcomes
 * @returns {Map<string, number>} 分隊 → 件數
 */
export function countVerifiedBySquad(outcomes) {
  const counts = new Map();
  for (const outcome of outcomes) {
    if (outcome.verdict !== VERDICT.before) continue;
    const squad = String(outcome.squad ?? '').trim();
    if (!squad) continue;
    counts.set(squad, (counts.get(squad) ?? 0) + 1);
  }
  return counts;
}
