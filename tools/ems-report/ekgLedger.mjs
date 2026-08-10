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
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PATHS, UNLOCK } from './config.mjs';
import { resolveColumnByNames } from './aggregate.mjs';
import { buildListSheet } from './ekgLists.mjs';
import { log } from './logger.mjs';
import { VERDICT } from './ekgVerify.mjs';

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

/** 取一列的某一欄，去掉前後空白；沒有那一欄就回傳空字串。 */
const cell = (row, column) => (column ? String(row[column] ?? '').trim() : '');

/**
 * 把一份匯出檔整理成「TEMSIS → 該案的基本資料」。
 *
 * 兩份匯出檔會有重疊（交集那些案件），後面合併時以先放進來的為準——
 * 與 `countUnionBySquad` 的去重規則一致，兩邊算出來的分母才會是同一批案件。
 *
 * @param {LedgerSource} source
 * @returns {Map<string, {squad: string, caseDate: string, arrival: string}>}
 */
function indexByTemsis(source) {
  const caseDateColumn = resolveColumnByNames(source.headers, UNLOCK.listColumns.caseDate)?.column ?? null;
  const indexed = new Map();
  for (const row of source.rows) {
    const temsis = cell(row, source.temsisColumn);
    if (!temsis || indexed.has(temsis)) continue;
    indexed.set(temsis, {
      squad: cell(row, source.squadColumn),
      caseDate: cell(row, caseDateColumn),
      arrival: cell(row, source.arrivalColumn),
    });
  }
  return indexed;
}

/**
 * 組出逐案判定表的資料列（純函式，不碰檔案）。
 *
 * @param {LedgerSource} ekgChecked 有勾 EKG檢查 的那份匯出檔
 * @param {LedgerSource} twelveLead 有 12 導程 的那份匯出檔
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes 逐案查核結果（可為空陣列）
 * @returns {unknown[][]} 與 {@link LEDGER_COLUMNS} 同順序的資料列
 */
export function buildLedgerRows(ekgChecked, twelveLead, outcomes) {
  const checkedIndex = indexByTemsis(ekgChecked);
  const twelveIndex = indexByTemsis(twelveLead);
  const outcomeIndex = new Map((outcomes ?? []).map((item) => [item.temsis, item]));

  // 先放 12 導程那份：有 12 導程的案件才有查核結果，讓它決定分隊與案件日期比較貼近查核當下。
  const allTemsis = [...new Set([...twelveIndex.keys(), ...checkedIndex.keys()])];

  const rows = allTemsis.map((temsis) => {
    const hasTwelveLead = twelveIndex.has(temsis);
    const hasProcedure = checkedIndex.has(temsis);
    const base = twelveIndex.get(temsis) ?? checkedIndex.get(temsis);
    const outcome = outcomeIndex.get(temsis);

    // 判定欄要分得出「查核過但沒過」與「根本沒得查」——這正是分隊最容易誤會的地方。
    const verdict = outcome?.verdict ?? (hasTwelveLead ? '未查核' : NOT_VERIFIABLE);
    const counted = outcome?.verdict === VERDICT.before;

    return [
      base?.squad ?? '(讀不到分隊)',
      base?.caseDate || '(讀不到)',
      temsis,
      hasProcedure ? '是' : '否',
      hasTwelveLead ? '是' : '否',
      outcome?.arrival || base?.arrival || '(讀不到)',
      outcome?.upload || '(讀不到)',
      verdict,
      counted ? '是' : '否',
      outcome?.reason ?? (hasTwelveLead ? '這次沒有查核到這一件' : '分母裡有這件，但沒有 12 導程可以查核上傳時間'),
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

/**
 * 組出逐案判定表的活頁簿（不寫檔，供測試在記憶體中檢查版面）。
 *
 * @param {unknown[][]} rows {@link buildLedgerRows} 的輸出
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {ExcelJS.Workbook}
 */
export function buildLedgerWorkbook(rows, monthRange) {
  const workbook = new ExcelJS.Workbook();
  buildListSheet(
    workbook,
    '逐案判定',
    `${monthRange.label}　${LEDGER.heading}`,
    LEDGER_COLUMNS,
    rows,
    { wideColumns: ['依據'] },
  );
  return workbook;
}

/**
 * 寫出逐案判定表。
 *
 * @param {LedgerSource} ekgChecked
 * @param {LedgerSource} twelveLead
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string|null>} 檔案路徑；一件都沒有時回傳 null
 */
export async function writeLedger(ekgChecked, twelveLead, outcomes, monthRange) {
  const rows = buildLedgerRows(ekgChecked, twelveLead, outcomes);
  if (rows.length === 0) {
    log.warn('分母一件都沒有，不產生逐案判定表。');
    return null;
  }

  const filePath = path.join(PATHS.reportDir, `${LEDGER.prefix}-${monthRange.label}.xlsx`);
  const workbook = buildLedgerWorkbook(rows, monthRange);
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
      + `（共 ${rows.length} 件，其中 ${counted} 件計入分子）`,
  );
  log.info('之後有人來問「某一件算在哪」，直接開這份檔案就看得到，不必重跑。');
  return filePath;
}
