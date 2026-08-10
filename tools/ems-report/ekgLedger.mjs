/**
 * 心電圖的**逐案判定表**——分母裡的每一件案子，各自算在哪裡。
 *
 * 為什麼要有這一份（使用者 2026-08-10 要求）：分隊拿自己的數字來對時，
 * 原本三種紀錄沒有一種答得出「這一件算在哪」——
 *   - 進度檔（`out/raw/*-ekg-verify-progress.json`）有全部結果，但**跑完就刪**（含完整 TEMSIS）
 *   - `last-run.log` **每次執行覆寫**，上個月的早就不在了
 *   - 待人工確認清單**只收判不出來**的那幾件
 * 結果就是每被問一次就要重跑一兩個小時。這份表把整個分母攤平成一件一列，
 * 留在 `out/report/`，要查直接開檔案。
 *
 * 涵蓋範圍是**分母（聯集）的全部案件**，因此包含三種歸屬：
 *   1. 有 12 導程且查核為到院前 → 計入分子
 *   2. 有 12 導程但查核為到院後／判不出來 → 不計入
 *   3. **只勾了 EKG檢查、沒有 12 導程** → 從頭到尾沒被查核過，不是判成到院後，是沒東西可判
 *
 * ⚠ 個資原則：含完整 TEMSIS 與時間，比照另外兩份清冊——
 *   檔案只落在 `out/report/`（已 gitignore、不上雲），終端機與 log 仍只印末 4 碼。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { EKG, PATHS, UNLOCK } from './config.mjs';
import { resolveColumnByNames } from './aggregate.mjs';
import { buildListSheet } from './ekgLists.mjs';
import { log } from './logger.mjs';
import { VERDICT } from './ekgVerify.mjs';
import { parseDateTime } from './timeParse.mjs';

/** 檔名前綴與大標（改名時兩個一起改）。 */
const LEDGER = { prefix: '心電圖逐案判定', heading: '心電圖逐案判定表' };

/** 欄位順序即輸出順序。 */
const LEDGER_COLUMNS = [
  '分隊', '案件日期', 'TEMSIS', '勾EKG檢查', '有12導程',
  '到院時間', '上傳時間', '判定', '計入分子', '依據',
];

/** 沒有 12 導程可查核時，「判定」欄要寫的話（不是判成到院後，是沒東西可判）。 */
const NOT_VERIFIABLE = '沒有12導程，未查核';

/**
 * @typedef {Object} LedgerSource 一份匯出檔，以及它的關鍵欄名
 * @property {string[]} headers
 * @property {Record<string, unknown>[]} rows
 * @property {string} temsisColumn
 * @property {string} squadColumn
 * @property {string|null} arrivalColumn 到院時間欄；匯出檔沒有這一欄時為 null
 */

/**
 * @typedef {Object} DenominatorCase 分母裡的一件案子，以及它算在哪
 * @property {string} temsis
 * @property {string} squad
 * @property {string} caseDate 案發日期原文
 * @property {number|null} epochMs 案發日期換算成毫秒；解析不出來為 null
 * @property {string} place 發生地點。**只供申訴表比對用，不寫進任何輸出檔**
 * @property {string} arrival 到院時間原文
 * @property {boolean} hasProcedure 有勾 EKG檢查
 * @property {boolean} hasTwelveLead 有 12 導程
 * @property {import('./ekgVerify.mjs').VerifyOutcome|null} outcome 查核結果；沒查核為 null
 * @property {boolean} counted 已計入分子
 */

/** 取一列的某一欄，去掉前後空白；沒有那一欄就回傳空字串。 */
const cell = (row, column) => (column ? String(row[column] ?? '').trim() : '');

/**
 * 把一份匯出檔整理成「TEMSIS → 該案的基本資料」。
 *
 * 兩份匯出檔會有重疊（交集那些案件），後面合併時以先放進來的為準——
 * 與 `countUnionBySquad` 的去重規則一致，兩邊算出來的分母才會是同一批案件。
 *
 * @param {LedgerSource} source
 * @returns {Map<string, {squad: string, caseDate: string, place: string, arrival: string}>}
 */
function indexByTemsis(source) {
  const columnFor = (candidates) => resolveColumnByNames(source.headers, candidates)?.column ?? null;
  const caseDateColumn = columnFor(UNLOCK.listColumns.caseDate);
  const placeColumn = columnFor(EKG.appeal.exportPlaceColumns);

  const indexed = new Map();
  for (const row of source.rows) {
    const temsis = cell(row, source.temsisColumn);
    if (!temsis || indexed.has(temsis)) continue;
    indexed.set(temsis, {
      squad: cell(row, source.squadColumn),
      caseDate: cell(row, caseDateColumn),
      place: cell(row, placeColumn),
      arrival: cell(row, source.arrivalColumn),
    });
  }
  return indexed;
}

/**
 * 把分母（聯集）攤平成一件一列，並標明各自算在哪。
 *
 * 逐案判定表與申訴表比對都以這個為準——「分母是哪些案件、哪些算進分子」
 * 只有一份定義，兩邊才不會各算各的。
 *
 * @param {LedgerSource} ekgChecked 有勾 EKG檢查 的那份匯出檔
 * @param {LedgerSource} twelveLead 有 12 導程 的那份匯出檔
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes 逐案查核結果（可為空陣列）
 * @returns {DenominatorCase[]}
 */
export function buildDenominatorCases(ekgChecked, twelveLead, outcomes) {
  const checkedIndex = indexByTemsis(ekgChecked);
  const twelveIndex = indexByTemsis(twelveLead);
  const outcomeIndex = new Map((outcomes ?? []).map((item) => [item.temsis, item]));

  // 先放 12 導程那份：有 12 導程的案件才有查核結果，讓它決定分隊與案件日期比較貼近查核當下。
  const allTemsis = [...new Set([...twelveIndex.keys(), ...checkedIndex.keys()])];

  return allTemsis.map((temsis) => {
    const base = twelveIndex.get(temsis) ?? checkedIndex.get(temsis);
    const outcome = outcomeIndex.get(temsis) ?? null;
    return {
      temsis,
      squad: base?.squad || '(讀不到分隊)',
      caseDate: base?.caseDate ?? '',
      epochMs: parseDateTime(base?.caseDate, {})?.epochMs ?? null,
      place: base?.place ?? '',
      arrival: outcome?.arrival || base?.arrival || '',
      hasProcedure: checkedIndex.has(temsis),
      hasTwelveLead: twelveIndex.has(temsis),
      outcome,
      counted: outcome?.verdict === VERDICT.before,
    };
  });
}

/**
 * 組出逐案判定表的資料列（純函式，不碰檔案）。
 *
 * @param {LedgerSource} ekgChecked
 * @param {LedgerSource} twelveLead
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes
 * @returns {unknown[][]} 與 {@link LEDGER_COLUMNS} 同順序的資料列
 */
export function buildLedgerRows(ekgChecked, twelveLead, outcomes) {
  // ⚠ 發生地點只用於申訴表比對，**不放進這裡的任何一欄**。
  const rows = buildDenominatorCases(ekgChecked, twelveLead, outcomes).map((item) => {
    // 判定欄要分得出「查核過但沒過」與「根本沒得查」——這正是分隊最容易誤會的地方。
    const verdict = item.outcome?.verdict ?? (item.hasTwelveLead ? '未查核' : NOT_VERIFIABLE);
    return [
      item.squad,
      item.caseDate || '(讀不到)',
      item.temsis,
      item.hasProcedure ? '是' : '否',
      item.hasTwelveLead ? '是' : '否',
      item.arrival || '(讀不到)',
      item.outcome?.upload || '(讀不到)',
      verdict,
      item.counted ? '是' : '否',
      item.outcome?.reason
        ?? (item.hasTwelveLead ? '這次沒有查核到這一件' : '分母裡有這件，但沒有 12 導程可以查核上傳時間'),
    ];
  });

  // 沒進分子的排前面：會來對數字的，要看的就是這些。同組內再依案件日期排。
  const countedIndex = LEDGER_COLUMNS.indexOf('計入分子');
  const dateIndex = LEDGER_COLUMNS.indexOf('案件日期');
  return rows.sort(
    (left, right) => String(left[countedIndex]).localeCompare(String(right[countedIndex]))
      || String(left[dateIndex]).localeCompare(String(right[dateIndex])),
  );
}

/** 申訴處理分頁的欄位。**不含發生地點**——那只用來比對，不輸出。 */
const APPEAL_COLUMNS = ['分隊', '表上填的案件日期', 'TEMSIS', '處理結果', '配對方式', '說明'];

/**
 * 組出逐案判定表的活頁簿（不寫檔，供測試在記憶體中檢查版面）。
 *
 * 第二個分頁放申訴處理結果：使用者要看的是「每一件的判斷狀況」，
 * 而申訴改判過的那幾件，光看逐案判定表只會看到原始判定，看不出被改過。
 *
 * @param {unknown[][]} rows {@link buildLedgerRows} 的輸出
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {import('./ekgAppeal.mjs').AppealResult[]} [appealResults]
 * @returns {ExcelJS.Workbook}
 */
export function buildLedgerWorkbook(rows, monthRange, appealResults = []) {
  const workbook = new ExcelJS.Workbook();
  const title = `${monthRange.label}　${LEDGER.heading}`;
  buildListSheet(workbook, '逐案判定', title, LEDGER_COLUMNS, rows, { wideColumns: ['依據'] });

  if (appealResults.length > 0) {
    const appealRows = appealResults.map((result) => [
      result.appeal.squad,
      result.appeal.caseDate,
      result.appeal.temsis || '(沒填)',
      result.outcome,
      result.matchedBy || '(配對不到)',
      result.reason,
    ]);
    buildListSheet(
      workbook,
      '申訴處理',
      `${monthRange.label}　分隊申訴處理結果`,
      APPEAL_COLUMNS,
      appealRows,
      { wideColumns: ['說明'] },
    );
  }
  return workbook;
}

/**
 * 寫出逐案判定表。
 *
 * @param {LedgerSource} ekgChecked
 * @param {LedgerSource} twelveLead
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {import('./ekgAppeal.mjs').AppealResult[]} [appealResults]
 * @returns {Promise<string|null>} 檔案路徑；一件都沒有時回傳 null
 */
export async function writeLedger(ekgChecked, twelveLead, outcomes, monthRange, appealResults = []) {
  const rows = buildLedgerRows(ekgChecked, twelveLead, outcomes);
  if (rows.length === 0) {
    log.warn('分母一件都沒有，不產生逐案判定表。');
    return null;
  }

  // 落在 internalDir 而不是 reportDir：這份不能跟要發給分隊的報表放在一起。
  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(PATHS.internalDir, `${LEDGER.prefix}-${monthRange.label}.xlsx`);
  const workbook = buildLedgerWorkbook(rows, monthRange, appealResults);
  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(
        `${path.basename(filePath)} 正被其他程式開啟（通常是 Excel），無法覆寫。請關閉後重新執行。`,
      );
    }
    throw error;
  }

  const countedIndex = LEDGER_COLUMNS.indexOf('計入分子');
  const counted = rows.filter((row) => row[countedIndex] === '是').length;
  log.ok(
    `逐案判定表已寫出：${path.relative(process.cwd(), filePath)}`
      + `（共 ${rows.length} 件，其中 ${counted} 件計入分子`
      + `${appealResults.length > 0 ? `；另有 ${appealResults.length} 件申訴列在第二個分頁` : ''}）`,
  );
  log.info('之後有人來問「某一件算在哪」，直接開這份檔案就看得到，不必重跑。');
  log.warn('⚠ 這份是內部查核紀錄（含全局每一件的判定），**不要發給分隊**，所以沒有放在 out/report/。');
  return filePath;
}
