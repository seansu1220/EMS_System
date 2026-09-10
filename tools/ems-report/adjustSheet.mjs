/**
 * 增減資料來源：Google 試算表。
 *
 * 用途：某些案件雖然在系統中被計為「有送醫」，但實際上不應列入分母，
 * 需依這份試算表逐筆扣除（每一列扣該分隊 1 件）。
 *
 * 取得方式：直接讀 Google 試算表的 CSV 匯出網址，不需要 API 金鑰，
 * 但該試算表必須設為「**知道連結的人可以檢視**」。
 *
 * ⚠ 個資原則：
 *   - 試算表網址只從 `.env` 讀取（已 gitignore），**任何輸出都不顯示網址**
 *   - `describeSheet` 只回報欄名與型態推測，**不回報任何儲存格內容**
 */
import path from 'node:path';
import { PATHS } from './config.mjs';

/**
 * @typedef {Object} SheetSource
 * @property {string} spreadsheetId 試算表 ID
 * @property {string|null} gid 分頁 gid；null 代表未指定（取第一個分頁）
 */

/** 組出 CSV 匯出網址。gid 為 null 時**不帶該參數**，Google 會回傳第一個分頁。 */
export function buildCsvUrl(spreadsheetId, gid) {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
  return gid === null || gid === undefined || gid === '' ? base : `${base}&gid=${gid}`;
}

/** 讀取 .env 並解析出試算表來源；未設定時回傳 null。 */
export function resolveSheetSource() {
  try {
    process.loadEnvFile(path.join(PATHS.toolDir, '.env'));
  } catch {
    // 沒有 .env 屬正常情況。
  }
  const url = (process.env.EMS_ADJUST_SHEET_URL ?? '').trim();
  if (!url) return null;

  const idMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url);
  if (!idMatch) {
    throw new Error(
      'EMS_ADJUST_SHEET_URL 看起來不是 Google 試算表網址（找不到 /spreadsheets/d/... 這段）。' +
        '請把瀏覽器網址列的整串網址貼上。',
    );
  }
  // 不可預設成 gid=0：第一個分頁的 gid 未必是 0（原始分頁被刪過就會變成別的數字），
  // 硬帶 gid=0 會得到 HTTP 400。未指定時一律不帶，讓 Google 回傳第一個分頁。
  const explicitGid = (process.env.EMS_ADJUST_SHEET_GID ?? '').trim() || /[#&?]gid=(\d+)/.exec(url)?.[1];
  return { spreadsheetId: idMatch[1], gid: explicitGid || null };
}

/**
 * 最小 CSV 解析器（處理引號、逸出引號與跨行儲存格）。
 * @param {string} input
 * @returns {string[][]}
 */
export function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

/**
 * 抓取試算表內容並解析為列陣列（第一列為欄位標題）。
 * @param {SheetSource} source
 * @returns {Promise<string[][]>}
 */
export async function fetchSheetRows(source) {
  const attempt = async (gid) => {
    let response;
    try {
      response = await fetch(buildCsvUrl(source.spreadsheetId, gid), { redirect: 'follow' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`連線到 Google 試算表失敗：${reason}`);
    }
    return response;
  };

  let response = await attempt(source.gid);
  // 指定的 gid 不存在時 Google 回 400；退一步改抓第一個分頁。
  if (response.status === 400 && source.gid !== null) {
    response = await attempt(null);
  }

  if (response.status === 404) {
    throw new Error('找不到這份試算表（HTTP 404）。請確認網址正確，且檔案沒有被刪除。');
  }
  if (!response.ok) {
    throw new Error(
      `讀取 Google 試算表失敗（HTTP ${response.status}）。` +
        '若為 400，通常是指定的分頁 gid 不存在；可清空 EMS_ADJUST_SHEET_GID 改用第一個分頁。',
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!/csv|text\/plain/i.test(contentType)) {
    throw new Error(
      '這份試算表沒有開放存取，讀到的是登入頁而不是資料。' +
        '請在試算表右上角「共用」中，把一般存取權改為「知道連結的任何人」→「檢視者」。',
    );
  }
  return parseCsv(text);
}

/**
 * 解析試算表裡的日期字串為 `YYYY-MM-DD`。
 *
 * 容錯處理常見寫法：`2026-06-01`、`2026/6/1`、後面接時間、以及**民國年**（如 `115/6/1`）。
 * 解析不出來時回傳 null，由呼叫端決定如何處理。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseSheetDate(text) {
  const matched = /(\d{2,4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/.exec(String(text ?? ''));
  if (!matched) return null;

  let year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 三碼以內視為民國年（例如 115 → 2026）。
  if (year < 1911) year += 1911;

  const pad = (value) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * 從試算表內容判斷「日期欄」與「分隊欄」是哪兩欄。
 *
 * 與匯出檔的作法一致：**看內容不看欄名**，因為使用者維護的表單欄名可能隨時改。
 *
 * @param {string[][]} rows 含標題列
 * @returns {{dateColumn: number, squadColumn: number}}
 */
export function resolveAdjustColumns(rows) {
  const body = rows.slice(1);
  if (body.length === 0) throw new Error('增減試算表沒有任何資料列');
  const columnCount = Math.max(...rows.map((row) => row.length));

  let dateColumn = -1;
  let squadColumn = -1;
  let bestDateScore = 0;
  let bestSquadScore = 0;

  for (let index = 0; index < columnCount; index += 1) {
    const values = body.map((row) => (row[index] ?? '').trim()).filter(Boolean);
    if (values.length === 0) continue;
    const dateScore = values.filter((value) => parseSheetDate(value) !== null).length / values.length;
    const squadScore = values.filter((value) => /(分隊|大隊|中隊)$/.test(value)).length / values.length;
    if (dateScore > bestDateScore && dateScore >= 0.7) {
      bestDateScore = dateScore;
      dateColumn = index;
    }
    if (squadScore > bestSquadScore && squadScore >= 0.7) {
      bestSquadScore = squadScore;
      squadColumn = index;
    }
  }

  if (dateColumn < 0) throw new Error('增減試算表中找不到日期欄（沒有任何一欄的內容大多是日期）');
  if (squadColumn < 0) throw new Error('增減試算表中找不到分隊欄（沒有任何一欄的內容大多以分隊／大隊結尾）');
  return {
    dateColumn,
    squadColumn,
    // TEMSIS 是對帳的鍵（見 `adjustAudit.mjs`）。找不到時為 -1，由呼叫端決定怎麼辦，
    // 不在這裡丟錯——`check-sheet` 只是要看看表長什麼樣子，不該因為少一欄就跑不動。
    temsisColumn: resolveAdjustTemsisColumn(rows),
    // 扣除原因只用來顯示（讓人看得懂那一列在講什麼），找不到就算了。
    reasonColumn: resolveAdjustReasonColumn(rows),
  };
}

/**
 * 找出「扣除原因」欄。
 *
 * 這一欄純粹是給人看的（對帳報表上要印出來，否則使用者看到一列「不採計」也不知道是什麼事），
 * 不參與任何判斷，因此**只用欄名比對**就夠——內容是自由文字，判不出型態。
 *
 * @param {string[][]} rows 含標題列
 * @returns {number} 欄索引；找不到時回傳 -1
 */
export function resolveAdjustReasonColumn(rows) {
  const headers = (rows[0] ?? []).map((text) => String(text ?? '').replace(/\s/g, ''));
  const candidates = ['扣除原因', '原因', '說明', '備註'];
  for (const candidate of candidates) {
    const index = headers.indexOf(candidate);
    if (index >= 0) return index;
  }
  const partial = headers.findIndex((header) => header.includes('原因'));
  return partial;
}

/**
 * 統計「期間內每個分隊要扣掉幾件」。
 *
 * 規則（使用者 2026-07-28 確認）：試算表每一列代表一件應排除的案件，
 * 若該列日期落在查詢期間內，就把該分隊的**送醫案件數（分母）扣 1**。
 * **預警案件數（分子）不動**——會列在這張表上的案件本來就不會是有到院前預警的案件。
 *
 * @param {string[][]} rows 含標題列
 * @param {{dateColumn: number, squadColumn: number}} columns
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {{counts: Map<string, number>, inRange: number, outOfRange: number, unparsable: number}}
 */
export function countAdjustmentsBySquad(rows, columns, monthRange) {
  const counts = new Map();
  let inRange = 0;
  let outOfRange = 0;
  let unparsable = 0;

  for (const row of rows.slice(1)) {
    const isoDate = parseSheetDate(row[columns.dateColumn] ?? '');
    if (isoDate === null) {
      unparsable += 1;
      continue;
    }
    if (isoDate < monthRange.start || isoDate > monthRange.end) {
      outOfRange += 1;
      continue;
    }
    const squad = String(row[columns.squadColumn] ?? '').trim();
    if (!squad) {
      unparsable += 1;
      continue;
    }
    counts.set(squad, (counts.get(squad) ?? 0) + 1);
    inRange += 1;
  }
  return { counts, inRange, outOfRange, unparsable };
}

/**
 * 只回報結構的診斷資訊，供確認欄位對應用。
 * **不回報任何儲存格內容**，只回報欄名與型態推測。
 *
 * @param {string[][]} rows
 * @returns {{rowCount: number, columnCount: number, columns: {index: number, header: string, filled: number, distinct: number, kinds: string[]}[]}}
 */
export function describeSheet(rows) {
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const columnCount = Math.max(0, ...rows.map((row) => row.length));

  const columns = [];
  for (let index = 0; index < columnCount; index += 1) {
    const values = body.map((row) => (row[index] ?? '').trim()).filter(Boolean);
    const ratioOf = (predicate) =>
      values.length === 0 ? 0 : values.filter(predicate).length / values.length;

    const kinds = [];
    // 用與實際判定相同的 parseSheetDate，否則診斷會說「不像日期」但程式卻判成日期欄，造成誤解。
    if (ratioOf((value) => parseSheetDate(value) !== null) > 0.7) kinds.push('日期');
    if (ratioOf((value) => /\d{1,2}:\d{2}/.test(value)) > 0.7) kinds.push('時間');
    if (ratioOf((value) => /(分隊|大隊|中隊)$/.test(value)) > 0.7) kinds.push('分隊名稱');
    if (ratioOf((value) => /^-?\d+(\.\d+)?$/.test(value)) > 0.7) kinds.push('數字');

    columns.push({
      index,
      header: (headers[index] ?? '').trim().slice(0, 40),
      filled: values.length,
      distinct: new Set(values).size,
      kinds,
    });
  }
  return { rowCount: rows.length, columnCount, columns };
}

/**
 * 找出試算表裡的「TEMSIS 欄」是哪一欄。
 *
 * 與日期欄、分隊欄一致，**看內容不看欄名**：這份表由使用者自己維護，
 * 欄名（目前是「案號(TEMSIS ID)」）隨時可能被改。
 * 判準是「值大多為一長串數字」——表上填錯少貼的情形不少（見 `EKG.appeal.temsisLength`
 * 的說明），因此只要求 15 碼以上，不強求完整 22 碼。
 *
 * @param {string[][]} rows 含標題列
 * @returns {number} 欄索引；找不到時回傳 -1（**不猜欄位**）
 */
export function resolveAdjustTemsisColumn(rows) {
  const body = rows.slice(1);
  if (body.length === 0) return -1;
  const columnCount = Math.max(...rows.map((row) => row.length));

  let bestColumn = -1;
  let bestScore = 0;
  for (let index = 0; index < columnCount; index += 1) {
    const values = body.map((row) => (row[index] ?? '').trim()).filter(Boolean);
    if (values.length === 0) continue;
    const score = values.filter((value) => /^\d{15,}$/.test(value)).length / values.length;
    if (score > bestScore && score >= 0.7) {
      bestScore = score;
      bestColumn = index;
    }
  }
  return bestColumn;
}

/**
 * @typedef {Object} AdjustRow 增減試算表上的一列（只留對帳與扣除要用的欄）
 * @property {string} temsis 表上填的 TEMSIS 原文（可能填錯或留空）
 * @property {string} squad 表上填的分隊
 * @property {string} caseDate 表上填的日期原文
 * @property {string} isoDate 解析後的 `YYYY-MM-DD`
 * @property {string} reason 扣除原因（只供顯示）
 * @property {number} lineNumber 試算表列號（含標題列，1 起算），供人回表上找那一列
 */

/**
 * 取出「期間內」的每一列，保留原始內容供逐列對帳。
 *
 * 與 {@link countAdjustmentsBySquad} 的差別：那支只回傳「哪一隊幾件」，
 * 這支回傳**每一列本身**——扣除改成要先驗證該案是不是真的沒預警（見 `adjustAudit.mjs`），
 * 只有件數是不夠的。
 *
 * @param {string[][]} rows 含標題列
 * @param {{dateColumn: number, squadColumn: number, temsisColumn: number, reasonColumn: number}} columns
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {{inRange: AdjustRow[], outOfRange: number, unparsable: number}}
 */
export function collectAdjustRows(rows, columns, monthRange) {
  const cell = (row, index) => (index >= 0 ? String(row[index] ?? '').trim() : '');
  const inRange = [];
  let outOfRange = 0;
  let unparsable = 0;

  rows.slice(1).forEach((row, index) => {
    const isoDate = parseSheetDate(row[columns.dateColumn] ?? '');
    if (isoDate === null) {
      unparsable += 1;
      return;
    }
    if (isoDate < monthRange.start || isoDate > monthRange.end) {
      outOfRange += 1;
      return;
    }
    const squad = cell(row, columns.squadColumn);
    if (!squad) {
      unparsable += 1;
      return;
    }
    inRange.push({
      temsis: cell(row, columns.temsisColumn),
      squad,
      caseDate: cell(row, columns.dateColumn),
      isoDate,
      reason: cell(row, columns.reasonColumn),
      // +2：陣列從 0 起算，而且第 1 列是標題，這樣算出來才是試算表上看到的列號。
      lineNumber: index + 2,
    });
  });

  return { inRange, outOfRange, unparsable };
}
