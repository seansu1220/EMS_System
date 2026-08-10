/**
 * 分隊申訴表：把「因非個人因素沒能順利上傳」的案件補回分子。
 *
 * 使用者 2026-08-10 的規則：
 *   1. 只看**案件日期落在查詢期間內**的列（那張表是累積的，跨好幾個月）
 *   2. 第一列資料是**範例**，固定跳過
 *   3. 找出它對應到系統裡哪一件：
 *      - 先用 **TEMSIS**（22 碼）比對
 *      - TEMSIS 長度不對或查不到 → 後備比對「**分隊＋發生地點＋時間相差 10 分鐘內**」
 *        （填表的人有的填派遣時間、有的填出動時間，不會完全一致）
 *   4. 依比對結果調整：
 *      - 找得到、**且已計入分子** → 什麼都不做（重複加會讓分子超過分母）
 *      - 找得到、未計入分子 → **分子 +1**，分母不變
 *      - 找不到 → 代表同仁既沒勾 EKG 處置也沒上傳心電圖，
 *        **分母 +1、分子 +1**，且「有處置未勾選」該分隊 **+1**
 *
 * ⚠ 個資原則：
 *   - 這張表另有「患者姓名」等欄，**一律不讀**
 *   - **發生地點只在記憶體裡做比對，不寫進任何輸出檔、不印在畫面上**
 *   - 畫面與紀錄檔上的 TEMSIS 一律只顯示末 4 碼
 */
import path from 'node:path';
import { EKG, PATHS } from './config.mjs';
import { fetchSheetRows } from './adjustSheet.mjs';
import { log } from './logger.mjs';
import { maskCode } from './sheetFields.mjs';
import { parseDateTime } from './timeParse.mjs';

/**
 * @typedef {Object} AppealRow 申訴表上的一列（只留比對要用的欄）
 * @property {string} temsis
 * @property {string} squad 由救護車編號推出的分隊
 * @property {string} caseDate 案件日期原文
 * @property {number|null} epochMs 案件日期換算成毫秒
 * @property {string} place 發生地點（**只在記憶體比對，不輸出**）
 * @property {number} lineNumber 試算表列號，供人回表上找那一列
 */

/**
 * @typedef {Object} AppealResult 一列申訴的處理結果
 * @property {AppealRow} appeal
 * @property {'已計入'|'補進分子'|'新增案件'|'無法處理'} outcome
 * @property {string} reason 寫給人看的說明
 * @property {string} matchedBy 用什麼條件配對到的（供複核）
 */

/**
 * 把人手填的時間寫法整理成 `parseDateTime` 看得懂的樣子。
 *
 * ⚠ 實測（2026-08-10）30 列裡有 5 列因為這兩種寫法被丟掉，其中一列還是查詢月份內的
 * ——申訴被默默漏掉，分隊卻以為填了就會算，這種錯沒有人會發現：
 *   - `2026/07/08 0620`　　　時間寫成 4 碼、沒有冒號
 *   - `2026/6/6 上午 7:03:00`　中文半日制
 *
 * 刻意放在這裡而不是改 `timeParse.mjs`：那支是拿來讀**系統畫面**的，
 * 格式由系統決定、相對規矩；這裡才是人工填寫的表單，兩者該分開放寬。
 *
 * @param {unknown} text
 * @returns {string} 整理後的字串（原本就正常的原樣回傳）
 */
export function normalizeSheetDateTime(text) {
  let value = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!value) return '';

  // 「上午 7:03」「下午 3:20」→ 24 小時制。
  const meridiem = /(上午|下午|AM|PM)\s*/i.exec(value);
  if (meridiem) {
    const isAfternoon = /下午|PM/i.test(meridiem[1]);
    value = value.replace(meridiem[0], '').replace(
      /(\d{1,2}):(\d{2})/,
      (whole, hour, minute) => {
        const adjusted = (Number(hour) % 12) + (isAfternoon ? 12 : 0);
        return `${String(adjusted).padStart(2, '0')}:${minute}`;
      },
    );
  }

  // 「… 0620」→「… 06:20」。只認**日期後面獨立的 4 碼數字**，
  // 已經有冒號的（`12:07`）與年份不會被動到。
  return value.replace(/\s(\d{2})(\d{2})(?!\d|:)/, ' $1:$2');
}

/** 從救護車編號推分隊：`平鎮91` → `平鎮分隊`。推不出來回傳空字串。 */
export function squadFromCarNumber(carNumber) {
  const name = String(carNumber ?? '').trim().replace(/\s/g, '').replace(/\d+$/, '');
  if (!name) return '';
  return name.endsWith('分隊') ? name : `${name}分隊`;
}

/** 依欄名候選找出試算表的某一欄索引；找不到回傳 -1。 */
function columnIndexOf(headers, candidates) {
  const normalize = (text) => String(text ?? '').replace(/\s/g, '');
  const wanted = candidates.map(normalize);
  const exact = headers.findIndex((header) => wanted.includes(normalize(header)));
  if (exact >= 0) return exact;
  return headers.findIndex((header) => wanted.some((name) => normalize(header).includes(name)));
}

/**
 * 找出申訴表的四個關鍵欄。缺任何一欄就中止並列出實際欄名——
 * 猜錯欄位會產出看起來正常但完全錯誤的調整。
 *
 * @param {string[][]} rows 含標題列的試算表內容
 * @returns {{temsis: number, caseDate: number, carNumber: number, place: number}}
 */
export function resolveAppealColumns(rows) {
  const headers = rows[0] ?? [];
  const resolved = {};
  const missing = [];
  for (const [key, candidates] of Object.entries(EKG.appeal.columns)) {
    const index = columnIndexOf(headers, candidates);
    if (index < 0) missing.push(`${key}（試過：${candidates.join('、')}）`);
    resolved[key] = index;
  }
  if (missing.length > 0) {
    throw new Error(
      `申訴表缺少必要欄位：${missing.join('；')}。`
        + `實際欄名有：${headers.map((header) => header || '(空白)').join('、')}。`
        + '請把正確欄名加進 config.mjs 的 EKG.appeal.columns。',
    );
  }
  return resolved;
}

/**
 * 把試算表內容整理成待處理的申訴列。
 *
 * @param {string[][]} rows 含標題列
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {{appeals: AppealRow[], skipped: {example: number, outOfRange: number, noSquad: string[], noDate: number}}}
 */
export function parseAppeals(rows, monthRange) {
  const columns = resolveAppealColumns(rows);
  const body = rows.slice(1);
  // 跳過的列一律記**列號**而不只是件數：要人去修表，就得講得出修哪一列。
  const skipped = { example: 0, outOfRange: 0, noSquad: [], noDate: [] };
  const appeals = [];

  for (const [position, row] of body.entries()) {
    const lineNumber = position + 2; // 試算表列號：標題列是第 1 列
    // 第一列資料是範例（使用者 2026-08-10 告知），連同它那筆填假的車號一起跳過。
    if (position < EKG.appeal.exampleRowCount) {
      skipped.example += 1;
      continue;
    }

    const caseDate = String(row[columns.caseDate] ?? '').trim();
    const parsed = parseDateTime(normalizeSheetDateTime(caseDate), {});
    if (!parsed) {
      skipped.noDate.push(String(lineNumber));
      continue;
    }
    const isoDate = new Date(parsed.epochMs).toISOString().slice(0, 10);
    if (isoDate < monthRange.start || isoDate > monthRange.end) {
      skipped.outOfRange += 1;
      continue;
    }

    const squad = squadFromCarNumber(row[columns.carNumber]);
    if (!squad) {
      // 分隊推不出來就不知道要加到哪一隊。**不猜**，列出列號請人補。
      skipped.noSquad.push(String(lineNumber));
      continue;
    }

    appeals.push({
      temsis: String(row[columns.temsis] ?? '').trim(),
      squad,
      caseDate,
      epochMs: parsed.epochMs,
      place: String(row[columns.place] ?? '').trim(),
      lineNumber,
    });
  }
  return { appeals, skipped };
}

/** 地點比對前先正規化：去掉全部空白與常見的區隔符號，避免「桃園市平鎮區…」寫法不一。 */
const normalizePlace = (text) => String(text ?? '').replace(/[\s,，、。()（）]/g, '');

/**
 * 後備比對：分隊相同、發生地點相同、案件時間相差在容差內。
 *
 * 為什麼不只比時間：同一分隊同一時段可能有好幾件案子，只比時間會配對到別件。
 * 為什麼不只比地點：同一個地點（例如某養護機構）一個月可能出勤很多次。
 * 三個條件一起，同一分隊、同一地點、10 分鐘內幾乎不可能有第二件。
 *
 * @param {AppealRow} appeal
 * @param {import('./ekgLedger.mjs').DenominatorCase[]} cases
 * @returns {import('./ekgLedger.mjs').DenominatorCase|null}
 */
export function matchByPlaceAndTime(appeal, cases) {
  const place = normalizePlace(appeal.place);
  if (!place || appeal.epochMs === null) return null;

  const matched = cases.filter((item) => item.squad === appeal.squad
    && normalizePlace(item.place) === place
    && item.epochMs !== null
    && Math.abs(item.epochMs - appeal.epochMs) <= EKG.appeal.timeToleranceMs);

  // 配對到兩件以上時**不選**：選錯會把調整加到別人的案件上，寧可回報讓人自己看。
  return matched.length === 1 ? matched[0] : null;
}

/**
 * 逐列比對申訴表與系統案件。
 *
 * @param {AppealRow[]} appeals
 * @param {import('./ekgLedger.mjs').DenominatorCase[]} cases 分母裡的全部案件
 * @returns {AppealResult[]}
 */
export function matchAppeals(appeals, cases) {
  const byTemsis = new Map(cases.map((item) => [item.temsis, item]));

  return appeals.map((appeal) => {
    const lengthOk = appeal.temsis.length === EKG.appeal.temsisLength;
    // 長度不對的一律不當成「查無此案」——那會讓分母分子平白各加 1 件，
    // 而它們多半只是打錯或少貼（實測 30 筆有 4 筆是 17 碼）。
    const byCode = lengthOk ? byTemsis.get(appeal.temsis) : undefined;
    const matched = byCode ?? matchByPlaceAndTime(appeal, cases);
    const matchedBy = byCode ? 'TEMSIS' : (matched ? '分隊＋發生地點＋時間相近' : '');

    if (matched) {
      if (matched.counted) {
        return {
          appeal,
          outcome: '已計入',
          matchedBy,
          reason: '這件本來就已經算進分子了，不重複加',
        };
      }
      return {
        appeal,
        outcome: '補進分子',
        matchedBy,
        reason: `原本${matched.hasTwelveLead ? '查核未通過' : '沒有 12 導程可查核'}，依申訴改列為到院前傳出`,
      };
    }

    if (!lengthOk && appeal.temsis) {
      return {
        appeal,
        outcome: '無法處理',
        matchedBy: '',
        reason: `TEMSIS 只有 ${appeal.temsis.length} 碼（應為 ${EKG.appeal.temsisLength} 碼），`
          + '而分隊＋發生地點＋時間也配對不到案件。請回表上確認編號',
      };
    }
    return {
      appeal,
      outcome: '新增案件',
      matchedBy: '',
      reason: '系統查詢結果裡沒有這一件（既沒勾 EKG 處置、也沒上傳心電圖），分母與分子都補 1 件',
    };
  });
}

/**
 * 把比對結果換算成各分隊要加的數字。
 *
 * @param {AppealResult[]} results
 * @returns {{numerator: Map<string, number>, denominator: Map<string, number>,
 *   missingProcedure: Map<string, number>}}
 */
export function tallyAdjustments(results) {
  const numerator = new Map();
  const denominator = new Map();
  const missingProcedure = new Map();
  const bump = (counts, squad) => counts.set(squad, (counts.get(squad) ?? 0) + 1);

  for (const result of results) {
    const { squad } = result.appeal;
    if (result.outcome === '補進分子') {
      bump(numerator, squad);
    } else if (result.outcome === '新增案件') {
      bump(numerator, squad);
      bump(denominator, squad);
      // 這種案件實際上有做心電圖卻沒勾處置，要一併提醒分隊補勾（使用者 2026-08-10 指定）。
      bump(missingProcedure, squad);
    }
  }
  return { numerator, denominator, missingProcedure };
}

/** 把 `分隊 N 件` 串成一行，供畫面顯示。 */
const describeCounts = (counts) => [...counts]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hant'))
  .map(([squad, count]) => `${squad} ${count} 件`)
  .join('、');

/** 把比對結果印在畫面上（TEMSIS 只印末 4 碼，發生地點一律不印）。 */
export function printAppealResults(results, skipped) {
  log.step('分隊申訴表');
  if (skipped.example > 0) log.info(`已跳過表上第 1 列的範例資料（${skipped.example} 列）`);
  if (skipped.outOfRange > 0) log.info(`不在查詢期間內：${skipped.outOfRange} 列（那張表是累積的）`);
  if (skipped.noDate.length > 0) {
    // 這是**會漏掉申訴**的錯誤：分隊以為填了就會算，實際上這幾列從頭到尾沒被處理。
    log.warn(
      `案件日期看不出來、整列沒有處理（試算表第 ${skipped.noDate.join('、')} 列）。`
        + '請回表上把日期補成 2026/07/08 06:20 這種寫法。',
    );
  }
  if (skipped.noSquad.length > 0) {
    log.warn(`救護車編號推不出分隊，這幾列沒有處理（試算表第 ${skipped.noSquad.join('、')} 列）`);
  }

  if (results.length === 0) {
    log.info('這個月沒有要處理的申訴案件。');
    return;
  }
  log.info(`這個月有 ${results.length} 件申訴：`);
  for (const result of results) {
    const level = result.outcome === '無法處理' ? 'warn' : 'info';
    log[level](
      `　${result.appeal.squad}　${result.appeal.caseDate}　${maskCode(result.appeal.temsis) || '(沒填TEMSIS)'}`
        + `　→　${result.outcome}${result.matchedBy ? `（以${result.matchedBy}配對）` : ''}`,
    );
    log.info(`　　${result.reason}`);
  }
}

/**
 * 讀申訴表。**未設定網址時回傳 null**（這是選用功能，沒設定不該讓整個流程失敗）。
 *
 * @returns {Promise<string[][]|null>} 含標題列的試算表內容
 */
export async function fetchAppealSheet() {
  try {
    process.loadEnvFile(path.join(PATHS.toolDir, '.env'));
  } catch {
    // 沒有 .env 屬正常情況（例如只跑測試時）。
  }
  const url = (process.env[EKG.appeal.urlEnvKey] ?? '').trim();
  if (!url) return null;

  const spreadsheetId = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url)?.[1];
  if (!spreadsheetId) {
    throw new Error(
      `${EKG.appeal.urlEnvKey} 看起來不是 Google 試算表網址（找不到 /spreadsheets/d/... 這段）。`
        + '請把瀏覽器網址列的整串網址貼上。',
    );
  }
  return fetchSheetRows({ spreadsheetId, gid: /[#&?]gid=(\d+)/.exec(url)?.[1] ?? null });
}

/**
 * 申訴表的完整流程：讀表 → 篩期間 → 比對 → 換算成各分隊要加的數字。
 *
 * 讀不到表**不中斷整個報表流程**：申訴是加分項，為了它讓跑了一兩個小時的
 * 查核結果整份作廢並不划算。改為明確警告，並照沒有申訴表的方式產出。
 *
 * @param {import('./ekgLedger.mjs').DenominatorCase[]} cases
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<{numerator: Map<string, number>, denominator: Map<string, number>,
 *   missingProcedure: Map<string, number>, results: AppealResult[]}|null>}
 */
export async function applyAppealSheet(cases, monthRange) {
  let rows;
  try {
    rows = await fetchAppealSheet();
  } catch (error) {
    log.warn(`申訴表讀取失敗，本次不套用申訴：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (rows === null) {
    log.info(`沒有設定 ${EKG.appeal.urlEnvKey}，略過分隊申訴表。`);
    return null;
  }

  const { appeals, skipped } = parseAppeals(rows, monthRange);
  const results = matchAppeals(appeals, cases);
  printAppealResults(results, skipped);

  const adjustments = { ...tallyAdjustments(results), results, skipped };
  if (adjustments.numerator.size > 0) {
    log.ok(`分子補進：${describeCounts(adjustments.numerator)}`);
  }
  if (adjustments.denominator.size > 0) {
    log.ok(`分母另外補進（系統查不到的案件）：${describeCounts(adjustments.denominator)}`);
  }
  return adjustments;
}
