/**
 * **人工判定清單**：程式判不出來的案件，交給使用者看完之後把結果填回來。
 *
 * 使用者 2026-09-21 要求：「就算你讀不出來，當我今天看完後，
 * 要怎麼請程式改為算進去或者不算進去？應該要有個我把審核結果丟回給程式
 * 去製作最終版本的統計數據才對。」
 *
 * ## 怎麼用（整個來回）
 *
 *   1. 跑一次月報表 → 產出 `{YYYY-MM}-心電圖-人工判定.xlsx`
 *   2. 使用者開檔案，點「檔案連結」欄的網址看原始檔案，在**「你的判定」欄**填
 *      **`算`** 或 **`不算`**（有下拉選單，不必自己打字），存檔
 *   3. 再跑一次同一個月 → 程式讀回這個檔案，把判定套進統計，產出最終報表
 *
 * 第 3 步**不必加任何參數**：程式每次跑都會先讀這個檔案。
 *
 * ## 為什麼要獨立一個檔案，而不是在既有清單上加一欄
 *
 * 既有的「待人工確認」「案件影音待確認」都是**這次的結果**，沒有案件就整份刪掉。
 * 判定要是寫在那種檔案上，會發生：使用者填了「算」→ 下次跑那件算進分子了 →
 * 它不再是待確認 → 檔案被刪 → 判定跟著消失 → 再下一次跑又掉回去。
 * 因此判定要有自己的家：**有填過判定的列永遠保留**，即使程式後來自己判得出來了。
 *
 * ## 判定的效力
 *
 * 人工判定是**最高權威**（見 `ekgVerify.countsAsNumerator`）：
 * 填「算」就計入分子、填「不算」就不計入，不管程式自己判成什麼。
 * 這是刻意的——會走到這一步，就是因為程式判不準，人看過的結論不該被程式推翻。
 *
 * ⚠ 個資：這份含完整 TEMSIS 與**檔案下載網址**，只落在 `out/internal/`
 *   （已 gitignore、不上雲），終端機只印末 4 碼與件數，不印網址。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PATHS } from './config.mjs';
import { buildListSheet } from './ekgLists.mjs';
import { monthlyFileName } from './fileNames.mjs';
import { log } from './logger.mjs';

/** 檔名前綴與大標（改名時兩個一起改）。 */
const REVIEW = { prefix: '心電圖-人工判定', heading: '心電圖人工判定清單' };

/** 欄位順序即輸出順序。 */
export const REVIEW_COLUMNS = [
  '分隊', '案件日期', 'TEMSIS', '為什麼要你看', '到院時間', '上傳時間',
  '相關檔案', '程式判讀', '判斷依據', '檔案連結（點開看）', '你的判定', '你的備註',
];

/** 使用者要填的那一欄，以及兩個合法的值。 */
export const REVIEW_COLUMN = '你的判定';
export const DECISION = { count: '算', skip: '不算' };

/**
 * 把使用者填的字轉成判定。
 *
 * **寫法放寬**是刻意的：這一欄是人手填的，要求只能填兩個特定字
 * 等於讓「填了但寫法不同」默默失效——而那是完全看不出來的錯。
 * 認不得的寫法會被列出來請人改，不會被當成沒填（見 `readDecisions`）。
 *
 * @param {unknown} text
 * @returns {'算'|'不算'|'看不懂'|null} 空白回傳 null
 */
export function parseDecision(text) {
  const value = String(text ?? '').replace(/[\s　]+/g, '').toUpperCase();
  if (!value) return null;
  if (['算', '計入', '要算', '是', 'Y', 'YES', 'V', '✓', 'O', '1'].includes(value)) return DECISION.count;
  if (['不算', '不計入', '否', 'N', 'NO', 'X', '✗', '0'].includes(value)) return DECISION.skip;
  return '看不懂';
}

/** 人工判定清單的檔案路徑。 */
export function reviewFilePath(monthRange) {
  return path.join(PATHS.internalDir, monthlyFileName(monthRange, REVIEW.prefix, 'xlsx'));
}

/**
 * 找出標題列（第 1 列是合併的大標，欄名在第 2 列）。
 * 不寫死列號：日後在上面多加一行說明也不會整份讀不到。
 *
 * @returns {{rowNumber: number, indexOf: (name: string) => number}|null}
 */
function findHeaderRow(sheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 10); rowNumber += 1) {
    const cells = (sheet.getRow(rowNumber).values ?? []).map((value) => String(value ?? '').trim());
    if (cells.includes('TEMSIS') && cells.includes(REVIEW_COLUMN)) {
      return { rowNumber, indexOf: (name) => cells.indexOf(name) };
    }
  }
  return null;
}

/**
 * 讀回上一次使用者填的判定。
 *
 * 檔案不存在、被刪掉、或格式壞掉都當成「沒有判定」——
 * 這是加分功能，不該因此讓整個月報表跑不出來。但**格式壞掉會大聲講**：
 * 默默忽略的話，使用者辛苦填了一整份卻完全沒生效，而畫面上一切正常。
 *
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<{decisions: Map<string, {decision: string, note: string}>,
 *   rows: Map<string, string[]>, unreadable: string[]}>}
 *   `rows`＝整列原值（重寫檔案時要沿用，不然使用者填過的列會消失）；
 *   `unreadable`＝填了但看不懂的那幾件（TEMSIS）
 */
export async function readDecisions(monthRange) {
  const empty = { decisions: new Map(), rows: new Map(), unreadable: [] };
  const filePath = reviewFilePath(monthRange);
  // 先自己確認檔案在不在：ExcelJS 對「檔案不存在」丟的是一般的 Error（沒有 ENOENT），
  // 靠 catch 分辨不出來，第一次跑就會冒出一句「讀不起來」的警告，看起來像出事了。
  const exists = await fs.access(filePath).then(() => true).catch(() => false);
  if (!exists) return empty;

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (error) {
    // 檔案在、卻讀不起來（壞掉、被改成別的格式）——這個要講，不能默默忽略。
    log.warn(`人工判定清單讀不起來（這次先當成沒有判定）：${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }

  const sheet = workbook.worksheets[0];
  const header = sheet && findHeaderRow(sheet);
  if (!header) {
    log.warn(
      `${path.basename(filePath)} 裡找不到「TEMSIS」與「${REVIEW_COLUMN}」這兩個欄名，`
        + '這次先當成沒有判定。請不要改動前兩列的欄名。',
    );
    return empty;
  }

  const temsisIndex = header.indexOf('TEMSIS');
  const decisionIndex = header.indexOf(REVIEW_COLUMN);
  const noteIndex = header.indexOf('你的備註');
  const decisions = new Map();
  const rows = new Map();
  const unreadable = [];

  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = (sheet.getRow(rowNumber).values ?? []).map((value) => String(value ?? '').trim());
    const temsis = values[temsisIndex] ?? '';
    if (!temsis) continue;
    // 整列存起來：重寫檔案時，程式這次判得出來的案件仍要把使用者填過的那一列留著。
    rows.set(temsis, REVIEW_COLUMNS.map((name) => values[header.indexOf(name)] ?? ''));

    const decision = parseDecision(values[decisionIndex]);
    if (decision === '看不懂') {
      unreadable.push(temsis);
      continue;
    }
    if (decision) {
      decisions.set(temsis, { decision, note: values[noteIndex] ?? '' });
    }
  }
  return { decisions, rows, unreadable };
}

/**
 * 把使用者的判定套進查核結果。
 *
 * **不改 `verdict`**，只掛一個 `manual` 上去：判定欄要照實寫程式判成什麼，
 * 再由 `countsAsNumerator()` 決定算不算。把 verdict 直接改成「到院前」比較省事，
 * 但那樣逐案判定表就看不出「這件是人工決定的」，日後沒人說得清數字怎麼來的。
 *
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes
 * @param {Map<string, {decision: string, note: string}>} decisions
 * @returns {{outcomes: import('./ekgVerify.mjs').VerifyOutcome[],
 *   applied: number, counted: number, skipped: number, missing: string[]}}
 *   `missing`＝填了判定、但這次查核結果裡沒有這件案子
 */
export function applyDecisions(outcomes, decisions) {
  const seen = new Set();
  let counted = 0;
  let skipped = 0;

  const applied = (outcomes ?? []).map((outcome) => {
    const manual = decisions.get(outcome.temsis);
    if (!manual) return outcome;
    seen.add(outcome.temsis);
    if (manual.decision === DECISION.count) counted += 1;
    else skipped += 1;
    return { ...outcome, manual };
  });

  const missing = [...decisions.keys()].filter((temsis) => !seen.has(temsis));
  return { outcomes: applied, applied: counted + skipped, counted, skipped, missing };
}

/**
 * 組出這次「要請使用者看」的列（純函式，不碰檔案）。
 *
 * 兩種案件會進來：
 *   1. **判定不出來**的（讀不到時間、進不了案件內部…）
 *   2. **案件影音判不出內容**的（照片 OCR 認不出來、檔案讀取失敗）
 *
 * 同一件案子只出一列：判定是對「這一件算不算」下的，一件出好幾列
 * 會讓使用者可以在同一件上填出互相矛盾的答案。
 *
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} outcomes
 * @param {string} unknownVerdict 代表「無法判定」的字串
 * @returns {string[][]} 與 {@link REVIEW_COLUMNS} 同順序（最後兩欄留白給使用者填）
 */
export function buildReviewRows(outcomes, unknownVerdict) {
  const rows = [];
  for (const outcome of outcomes ?? []) {
    const reviews = outcome.mediaReviews ?? [];
    const isUnknown = outcome.verdict === unknownVerdict;
    if (!isUnknown && reviews.length === 0) continue;

    const reasons = [];
    if (isUnknown) reasons.push('程式判定不出來');
    if (reviews.length > 0) reasons.push(`案件影音有 ${reviews.length} 個檔案判不出內容`);

    rows.push([
      outcome.squad,
      outcome.caseDate || '(讀不到)',
      outcome.temsis,
      reasons.join('；'),
      outcome.arrival || '(讀不到)',
      // 影音那幾列各有自己的上傳時間，逐案判定的上傳時間可能是別的來源，兩個都給。
      outcome.upload || reviews.map((item) => item.uploadTime).filter(Boolean).join('、') || '(讀不到)',
      reviews.map((item) => item.fileName).join('\n') || '(沒有檔案)',
      reviews.map((item) => item.kind).join('\n') || outcome.verdict,
      reviews.map((item) => item.why).join('\n') || outcome.reason,
      reviews.map((item) => item.url).filter(Boolean).join('\n'),
      '',
      '',
    ]);
  }
  return rows;
}

/**
 * 把這次要看的列，與上次填過判定的列合併。
 *
 * ⚠ **填過判定的列一定要留著**，即使程式這次自己判得出來了。
 *   刪掉的話下一次跑就會掉回程式的判定，數字會自己變來變去。
 *
 * @param {string[][]} freshRows {@link buildReviewRows} 的輸出
 * @param {Map<string, string[]>} previousRows 上次檔案裡的整列
 * @param {Map<string, {decision: string, note: string}>} decisions
 * @returns {string[][]}
 */
export function mergeReviewRows(freshRows, previousRows, decisions) {
  const temsisIndex = REVIEW_COLUMNS.indexOf('TEMSIS');
  const decisionIndex = REVIEW_COLUMNS.indexOf(REVIEW_COLUMN);
  const noteIndex = REVIEW_COLUMNS.indexOf('你的備註');
  const reasonIndex = REVIEW_COLUMNS.indexOf('為什麼要你看');

  const merged = freshRows.map((row) => {
    const previous = previousRows.get(row[temsisIndex]);
    if (!previous) return row;
    // 顯示欄用這次的最新結果，判定與備註沿用使用者填的。
    const copy = [...row];
    copy[decisionIndex] = previous[decisionIndex] ?? '';
    copy[noteIndex] = previous[noteIndex] ?? '';
    return copy;
  });

  const kept = new Set(freshRows.map((row) => row[temsisIndex]));
  for (const [temsis, previous] of previousRows) {
    if (kept.has(temsis) || !decisions.has(temsis)) continue;
    const carried = [...previous];
    carried[reasonIndex] = '(這次程式已經判得出來了，保留你先前填的判定)';
    merged.push(carried);
  }

  // 還沒填判定的排前面：使用者開檔案要做的事就是填那些。
  return merged.sort(
    (left, right) => String(left[decisionIndex] || '').localeCompare(String(right[decisionIndex] || ''))
      || String(left[0]).localeCompare(String(right[0]), 'zh-Hant'),
  );
}

/**
 * 寫出人工判定清單。
 *
 * **一列都沒有時不刪舊檔**——與其他清單相反，這裡刻意不清：
 * 這個檔案裝的是使用者的判定，不是這次的結果。刪掉就等於把他填的東西丟了。
 *
 * @param {string[][]} rows {@link mergeReviewRows} 的輸出
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<{filePath: string|null, pending: number}>}
 *   `pending`＝還沒填判定的件數
 */
export async function writeReviewList(rows, monthRange) {
  const filePath = reviewFilePath(monthRange);
  if (rows.length === 0) {
    log.info('這次沒有需要人工判定的案件（先前若有填過判定的檔案會原樣留著）。');
    return { filePath: null, pending: 0 };
  }

  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = buildListSheet(
    workbook,
    '人工判定',
    `${monthRange.label}　${REVIEW.heading}　←　看完後在「${REVIEW_COLUMN}」欄填「${DECISION.count}」或「${DECISION.skip}」，存檔後再跑一次`,
    REVIEW_COLUMNS,
    rows,
    { wideColumns: ['為什麼要你看', '判斷依據', '檔案連結（點開看）', '你的備註'] },
  );

  // 下拉選單：這一欄是整條來回的關鍵，打錯字就整列失效，能點就不要讓人打字。
  const decisionColumn = REVIEW_COLUMNS.indexOf(REVIEW_COLUMN) + 1;
  for (let offset = 0; offset < rows.length; offset += 1) {
    sheet.getCell(offset + 3, decisionColumn).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${DECISION.count},${DECISION.skip}"`],
    };
  }

  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      throw new Error(
        `${path.basename(filePath)} 正被其他程式開啟（通常是 Excel），無法覆寫。`
          + '請關閉後重新執行；你已經填好的判定都還在，不會遺失。',
      );
    }
    throw error;
  }

  const decisionIndex = REVIEW_COLUMNS.indexOf(REVIEW_COLUMN);
  const pending = rows.filter((row) => !row[decisionIndex]).length;
  log.ok(`人工判定清單已寫出：${path.relative(process.cwd(), filePath)}（共 ${rows.length} 件）`);
  return { filePath, pending };
}
