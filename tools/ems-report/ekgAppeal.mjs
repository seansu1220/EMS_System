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
import { fetchSheetRows, parseSheetDate } from './adjustSheet.mjs';
import { log } from './logger.mjs';
import { maskCode } from './sheetFields.mjs';
import { parseDateTime } from './timeParse.mjs';

/**
 * @typedef {Object} AppealRow 申訴表上的一列（只留比對要用的欄）
 * @property {string} temsis
 * @property {string} squad 由救護車編號推出的分隊；表上沒有那一欄或沒填時為空字串
 * @property {string} caseDate 案件日期原文
 * @property {number|null} epochMs 案件日期換算成毫秒（只有日期時為當天 00:00）
 * @property {boolean} hasTime 表上有沒有填時分。沒填時後備比對改成「同一天」
 * @property {string} place 發生地點（**只在記憶體比對，不輸出**）
 * @property {string} remark 表上寫的原因（使用者 2026-09-21 要求列出來看；沒有這一欄時為空字串）
 * @property {number} lineNumber 試算表列號，供人回表上找那一列
 */

/**
 * 解析申訴表的案件日期，**允許只有日期沒有時間**。
 *
 * ⚠ `parseDateTime()` 對「2026/07/19」這種只有日期的寫法一律回傳 null——
 * 那支是設計來讀**系統畫面**的，那邊的時間一定帶時分。人工填的表不該用同一套標準：
 * 實測（2026-08-10）就有人只填日期，整列因此被丟掉，但它的 TEMSIS 是好的，
 * 本來光靠 TEMSIS 就認得出是哪一件（使用者指正）。
 *
 * @param {string} text 已經過 {@link normalizeSheetDateTime} 整理的字串
 * @returns {{epochMs: number, hasTime: boolean}|null}
 */
export function parseAppealDate(text) {
  const withTime = parseDateTime(text, {});
  if (withTime) return { epochMs: withTime.epochMs, hasTime: true };

  // 退一步只認日期（`parseSheetDate` 連民國年都接得住）。時間當成當天 00:00。
  const isoDate = parseSheetDate(text);
  return isoDate ? { epochMs: Date.parse(`${isoDate}T00:00:00Z`), hasTime: false } : null;
}

/**
 * @typedef {Object} AppealResult 一列申訴的處理結果
 * @property {AppealRow} appeal
 * @property {'已計入'|'補進分子'|'新增案件'|'無法處理'|'已排除'} outcome
 * @property {string} reason 寫給人看的說明
 * @property {string} matchedBy 用什麼條件配對到的（供複核）
 * @property {string} squad **實際要調整的分隊**：配對到案件時用系統登記的那一個，
 *   系統查不到時才用表上車號推出來的；兩者都沒有時為空字串（那種列一律不動數字）
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
 * 找出申訴表的各欄。
 *
 * **只有 TEMSIS 是必填**（2026-10-09 起）：那是認出「這筆申訴是系統裡哪一件案子」
 * 的唯一鍵，少了就真的算不出來，因此找不到會中止並列出實際欄名
 * ——猜錯欄位會產出看起來正常但完全錯誤的調整。
 *
 * 其餘（案件日期、救護車編號、發生地點、備註）都是選填，找不到回 -1、**絕不中止**。
 * 它們都有替代來源或只影響後備路線，詳見 `EKG.appeal.optionalColumns` 的說明。
 *
 * @param {string[][]} rows 含標題列的試算表內容
 * @returns {{temsis: number, caseDate: number, carNumber: number, place: number, remark: number}}
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
  for (const [key, candidates] of Object.entries(EKG.appeal.optionalColumns ?? {})) {
    resolved[key] = columnIndexOf(headers, candidates);
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
 * @returns {{appeals: AppealRow[], skipped: {example: number, outOfRange: number, noDate: string[]}}}
 */
export function parseAppeals(rows, monthRange) {
  const columns = resolveAppealColumns(rows);
  const body = rows.slice(1);
  // 跳過的列一律記**列號**而不只是件數：要人去修表，就得講得出修哪一列。
  // `noSquad` 在 2026-10-09 移除：推不出分隊已經不會丟掉整列了（見下方說明）。
  const skipped = { example: 0, outOfRange: 0, noDate: [] };
  const appeals = [];

  for (const [position, row] of body.entries()) {
    const lineNumber = position + 2; // 試算表列號：標題列是第 1 列
    // 第一列資料是範例（使用者 2026-08-10 告知），連同它那筆填假的車號一起跳過。
    if (position < EKG.appeal.exampleRowCount) {
      skipped.example += 1;
      continue;
    }

    const temsis = String(row[columns.temsis] ?? '').trim();
    const caseDate = String(row[columns.caseDate] ?? '').trim();

    /**
     * 案件日期：先用表上那一欄，讀不出來就**從 TEMSIS 前 8 碼推**（2026-10-09 加）。
     *
     * 表上沒有這一欄、或某一列忘了填時，舊版把整列丟掉——申訴被默默漏掉，
     * 而分隊以為填了就會算。TEMSIS 本身就帶著案發日期，沒必要為了一個
     * 推得出來的值而放棄一整列。
     */
    const fromSheet = parseAppealDate(normalizeSheetDateTime(caseDate));
    const parsed = fromSheet ?? dateFromTemsis(temsis);
    if (!parsed) {
      skipped.noDate.push(String(lineNumber));
      continue;
    }
    /**
     * 畫面與清冊上要**看得出這個日期是推算來的**，表上原本寫了什麼也要留著
     * ——不然使用者看到一個正常的日期，不會知道表上那一格其實是空的或寫錯了。
     */
    const derivedDate = new Date(parsed.epochMs).toISOString().slice(0, 10);
    const caseDateText = fromSheet
      ? caseDate
      : `${caseDate ? `${caseDate} → ` : ''}${derivedDate}（由 TEMSIS 推算）`;
    const isoDate = new Date(parsed.epochMs).toISOString().slice(0, 10);
    if (isoDate < monthRange.start || isoDate > monthRange.end) {
      skipped.outOfRange += 1;
      continue;
    }

    /**
     * 分隊：由救護車編號推出（`平鎮91` → `平鎮分隊`）。
     *
     * ⚠ **推不出來不再丟掉整列**（2026-10-09 改）。配對到系統案件時，
     *   分隊會改用那件案子在系統裡登記的分隊（見 `matchAppeals`），那本來就比表上準。
     *   只有「系統完全查不到的案件」才真的需要表上這一欄——
     *   那種情形才會在比對階段被列為無法處理，而且說得出原因。
     *   舊版在這裡就把整列丟掉，等於為了一個多數情況下用不到的值而漏掉申訴。
     */
    const squad = squadFromCarNumber(row[columns.carNumber]);

    appeals.push({
      temsis,
      squad,
      caseDate: caseDateText,
      epochMs: parsed.epochMs,
      hasTime: parsed.hasTime,
      // 沒有發生地點欄時 columns.place 是 -1，`row[-1]` 讀出 undefined，正好變成空字串
      // （沒有地點就只是用不到「分隊＋地點＋時間」那條後備配對）。
      place: String(row[columns.place] ?? '').trim(),
      // 沒有備註欄時 columns.remark 是 -1，`row[-1]` 讀出 undefined，正好變成空字串。
      remark: String(row[columns.remark] ?? '').trim(),
      lineNumber,
    });
  }
  return { appeals, skipped };
}

/**
 * 從 TEMSIS 推出案件日期。
 *
 * TEMSIS 的前 8 碼就是案發日期（`20260905…` → 2026-09-05）。
 * 實測 2026-09 的 284 件**全部吻合**，因此在表上沒有案件日期欄、
 * 或那一格沒填時，拿它當來源是可靠的（2026-10-09 加）。
 *
 * ⚠ 只接受長度正確的 TEMSIS：長度不對的多半是打錯或少貼，
 *   拿前 8 碼去推會得到一個看似合法卻錯誤的日期，而日期決定這一列算哪個月。
 *
 * @param {string} temsis
 * @returns {{epochMs: number, hasTime: boolean}|null}
 */
export function dateFromTemsis(temsis) {
  const code = String(temsis ?? '').trim();
  if (code.length !== EKG.appeal.temsisLength) return null;
  const parsed = parseAppealDate(`${code.slice(0, 4)}/${code.slice(4, 6)}/${code.slice(6, 8)}`);
  return parsed;
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

  // 表上只填日期沒填時分時，時間比不了，改成要求「同一天」——
  // 否則會拿當天 00:00 去比，10 分鐘容差內幾乎不可能有案件，等於這條路直接斷掉。
  const dayOf = (epochMs) => new Date(epochMs).toISOString().slice(0, 10);
  const closeEnough = (epochMs) => (appeal.hasTime === false
    ? dayOf(epochMs) === dayOf(appeal.epochMs)
    : Math.abs(epochMs - appeal.epochMs) <= EKG.appeal.timeToleranceMs);

  const matched = cases.filter((item) => item.squad === appeal.squad
    && normalizePlace(item.place) === place
    && item.epochMs !== null
    && closeEnough(item.epochMs));

  // 配對到兩件以上時**不選**：選錯會把調整加到別人的案件上，寧可回報讓人自己看。
  return matched.length === 1 ? matched[0] : null;
}

/**
 * 逐列比對申訴表與系統案件。
 *
 * @param {AppealRow[]} appeals
 * @param {import('./ekgLedger.mjs').DenominatorCase[]} cases 分母裡的全部案件
 * 每一筆結果都帶 `squad`＝**實際要調整的分隊**：配對到系統案件時用那件案子在系統裡
 * 登記的分隊（那本來就比表上準，與第 1 章的對帳同一個原則，見 1.13），
 * 只有系統查不到的案件才退而用表上推出來的分隊。
 *
 * @returns {AppealResult[]}
 */
export function matchAppeals(appeals, cases, excludedCases = []) {
  const byTemsis = new Map(cases.map((item) => [item.temsis, item]));
  const excludedByTemsis = new Map(excludedCases.map((item) => [item.temsis, item]));

  return appeals.map((appeal) => {
    const lengthOk = appeal.temsis.length === EKG.appeal.temsisLength;
    // 長度不對的一律不當成「查無此案」——那會讓分母分子平白各加 1 件，
    // 而它們多半只是打錯或少貼（實測 30 筆有 4 筆是 17 碼）。
    const byCode = lengthOk ? byTemsis.get(appeal.temsis) : undefined;
    const matched = byCode ?? matchByPlaceAndTime(appeal, cases);
    const matchedBy = byCode ? 'TEMSIS' : (matched ? '分隊＋發生地點＋時間相近' : '');

    /**
     * ⚠ 先看這件是不是**已經因為 OHCA 被排除**的案件。
     *
     * 不擋的話，排除等於白做：那件不在 `cases` 裡，於是申訴比對會判成
     * 「新增案件」而把分母分子各補 1 回去，還順便算進分子——
     * 比沒排除還糟（2026-08-13 實跑，平鎮 7/19 與龍岡 7/17 兩件都這樣）。
     *
     * 排除的理由（是 OHCA、不屬於這個指標）與申訴的理由（非個人因素沒能上傳）
     * 是兩回事，前者優先：案件根本不該在母體裡，就沒有補不補的問題。
     */
    if (!matched) {
      const excluded = (lengthOk ? excludedByTemsis.get(appeal.temsis) : undefined)
        ?? matchByPlaceAndTime(appeal, excludedCases);
      if (excluded) {
        return {
          appeal,
          outcome: '已排除',
          matchedBy: excludedByTemsis.has(appeal.temsis) ? 'TEMSIS' : '分隊＋發生地點＋時間相近',
          squad: excluded.squad,
          reason: '這件的處置勾了 CPR（OHCA 案件），已排除在分母與分子之外，不因申訴補回',
        };
      }
    }

    if (matched) {
      // 分隊一律用系統登記的那一個：表上填錯隊時，加到表上那一隊是錯的
      //   ——那一隊的分母裡根本沒有這一件（與 1.13 的對帳同一個理由）。
      const note = (appeal.squad && appeal.squad !== matched.squad)
        ? `；順帶一提，表上的車號推出來是「${appeal.squad}」，但系統登記為「${matched.squad}」，已用系統的`
        : '';
      if (matched.counted) {
        return {
          appeal,
          outcome: '已計入',
          matchedBy,
          squad: matched.squad,
          reason: `這件本來就已經算進分子了，不重複加${note}`,
        };
      }
      return {
        appeal,
        outcome: '補進分子',
        matchedBy,
        squad: matched.squad,
        reason: `原本${matched.hasTwelveLead ? '查核未通過' : '沒有 12 導程可查核'}，依申訴改列為到院前傳出${note}`,
      };
    }

    if (!lengthOk && appeal.temsis) {
      return {
        appeal,
        outcome: '無法處理',
        matchedBy: '',
        squad: appeal.squad,
        reason: `TEMSIS 只有 ${appeal.temsis.length} 碼（應為 ${EKG.appeal.temsisLength} 碼），`
          + '而分隊＋發生地點＋時間也配對不到案件。請回表上確認編號',
      };
    }

    /**
     * 系統查不到的案件要補 1 件到某一隊的分母與分子——**這時非得知道是哪一隊不可**。
     *
     * 配對得到案件時分隊可以從系統拿，但這條路沒有案件可拿。
     * 表上又推不出分隊（沒有救護車編號欄、或那一格沒填）就**不猜**：
     * 加到錯的分隊，等於憑空改動兩個分隊的成績。
     */
    if (!appeal.squad) {
      return {
        appeal,
        outcome: '無法處理',
        matchedBy: '',
        squad: '',
        reason: '這件不在本次兩份查詢結果裡，本來要幫它補分母與分子，'
          + '但表上推不出是哪一個分隊（需要救護車編號，例如「平鎮91」），因此沒有處理。'
          + '請在表上補救護車編號，或確認 TEMSIS 是否填對',
      };
    }

    return {
      appeal,
      outcome: '新增案件',
      matchedBy: '',
      squad: appeal.squad,
      // ⚠ 措辭要講明是「**不在這兩份查詢結果裡**」，不是「系統裡沒有這件案子」。
      //   使用者 2026-08-10 看到舊寫法後回系統查，案件當然找得到，於是以為程式錯了。
      reason: '不在本次兩份查詢結果裡（既沒勾 EKG 處置、也沒上傳心電圖），'
        + '分母與分子各補 1 件，並列入有處置未勾選清冊',
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
    // ⚠ 用 `result.squad`（實際要調整的分隊），不是 `result.appeal.squad`（表上填的）。
    //   表上填錯隊時，加到表上那一隊是錯的（與 1.13 的對帳同一個理由）。
    const squad = result.squad || result.appeal.squad;
    if (!squad) continue; // 分隊不明的一律不動數字（上面已判成「無法處理」並說明原因）。
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
    /**
     * **填不完整的列一律視為沒有提報**（使用者 2026-10-09 決定）。
     *
     * 這幾列既讀不出案件日期、TEMSIS 也不完整，無從認出是哪一件案子。
     * 以前當成「要使用者去修」的待辦事項，但那張表是累積的，
     * 同樣幾列每個月都會再被唸一次。
     *
     * ⚠ 仍然**逐列列出列號**：改成不唸不等於不留紀錄。
     *   哪天分隊來問「我明明填了為什麼沒算」，要答得出是哪一列、為什麼。
     */
    log.info(
      `以下各列的 TEMSIS 不完整、也讀不出案件日期，視為沒有提報（試算表第 ${
        skipped.noDate.join('、')} 列）。`
        + `要讓它們算進去，請把 TEMSIS 補成完整的 ${EKG.appeal.temsisLength} 碼。`,
    );
  }

  if (results.length === 0) {
    log.info('這個月沒有要處理的申訴案件。');
    return;
  }
  log.info(`這個月有 ${results.length} 件申訴：`);
  for (const result of results) {
    // 「無法處理」＝那一列填不完整，視為沒有提報（使用者 2026-10-09 決定），
    // 因此用一般訊息而不是警告——它不是要人動手的事，只是要留著備查。
    const level = 'info';
    log[level](
      `　${result.squad || result.appeal.squad || '(分隊不明)'}　${result.appeal.caseDate}`
        + `　${maskCode(result.appeal.temsis) || '(沒填TEMSIS)'}`
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
export async function applyAppealSheet(cases, monthRange, excludedCases = []) {
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
  const results = matchAppeals(appeals, cases, excludedCases);
  printAppealResults(results, skipped);

  // 申訴到已排除的 OHCA 案件時要講出來：分隊填了表卻沒有被補回去，
  // 不說的話他們只會看到成績沒動，卻不知道為什麼。
  const excludedHits = results.filter((item) => item.outcome === '已排除');
  if (excludedHits.length > 0) {
    log.warn(
      `有 ${excludedHits.length} 件申訴指到「已排除的 OHCA 案件」（處置勾了 CPR），不補回分母分子。`,
    );
  }

  const adjustments = { ...tallyAdjustments(results), results, skipped };
  if (adjustments.numerator.size > 0) {
    log.ok(`分子補進：${describeCounts(adjustments.numerator)}`);
  }
  if (adjustments.denominator.size > 0) {
    log.ok(`分母另外補進（不在兩份查詢結果裡的案件）：${describeCounts(adjustments.denominator)}`);
  }
  // 這一項也要印。少印它使用者會以為只加了分母分子、清冊沒處理（2026-08-10 實際誤會過）。
  if (adjustments.missingProcedure.size > 0) {
    log.ok(`有處置未勾選清冊補列：${describeCounts(adjustments.missingProcedure)}`);
  }
  return adjustments;
}
