/**
 * 把 **OHCA 案件排除在 12 導程傳輸率之外**（純函式，不碰檔案也不碰畫面）。
 *
 * 判定規則是使用者 2026-08-13 決定的：**處置項目勾了 CPR 就是 OHCA 案件**。
 * OHCA 心電圖與 12 導程心電圖是兩回事，不該拿來算 12 導程的到院前傳輸率，
 * 因此分母與分子都要把它們拿掉。
 *
 * 為什麼規則長這樣（查證過程見 TOOLS_SPEC 3.12.1）：
 *   - 系統的心電圖下拉本來就把 12導程／到院前OHCA／到院後OHCA 分成不同選項，
 *     **查詢條件沒有下錯**；誤標的那件在系統資料裡就是掛在 12 導程底下
 *   - 三種類型在系統裡**互斥**（與 12 導程的重疊都是 0 件），所以從類型看不出誤標
 *   - 數救護紀錄表的字樣**完全沒有鑑別力**（那些字是表單上印好的欄位標籤）
 *   - 只有「處置勾了 CPR」這個條件分得出來，而且它是查詢頁上的勾選框，
 *     一次查詢就撈得出整批
 *
 * ⚠ 排除掉的案件**不可以默默消失**。這裡回傳被拿掉的那些列，
 *   讓呼叫端印在終端機、寫進執行報告與逐案判定表——看得見才查得出原因。
 */

/** 逐案判定表上，被排除的案件要寫的「判定」。 */
export const EXCLUDED_VERDICT = '排除：處置勾CPR';

/** 逐案判定表上，被排除的案件要寫的「依據」。 */
export const EXCLUDED_REASON = '處置項目勾了 CPR ＝ OHCA 案件，不列入 12 導程傳輸率的分母與分子';

/**
 * 取出一份匯出檔裡所有的 TEMSIS（去掉前後空白與空值）。
 *
 * @param {Record<string, unknown>[]} rows
 * @param {string} temsisColumn
 * @returns {Set<string>}
 */
export function temsisSetOf(rows, temsisColumn) {
  const found = new Set();
  for (const row of rows ?? []) {
    const temsis = String(row?.[temsisColumn] ?? '').trim();
    if (temsis) found.add(temsis);
  }
  return found;
}

/**
 * 依 TEMSIS 把要排除的列拆出來。
 *
 * @param {Record<string, unknown>[]} rows 一份匯出檔的資料列
 * @param {string} temsisColumn 這份匯出檔的 TEMSIS 欄名
 * @param {Set<string>} excluded 要排除的 TEMSIS
 * @returns {{kept: Record<string, unknown>[], removed: Record<string, unknown>[]}}
 */
export function splitExcluded(rows, temsisColumn, excluded) {
  const kept = [];
  const removed = [];
  for (const row of rows ?? []) {
    const temsis = String(row?.[temsisColumn] ?? '').trim();
    // TEMSIS 空白的留著：那是資料本身的問題，不該被當成「要排除的 OHCA 案件」
    // 而悄悄消失（空字串永遠不會在 excluded 裡，這裡寫明只是為了讓意圖清楚）。
    (temsis && excluded.has(temsis) ? removed : kept).push(row);
  }
  return { kept, removed };
}

/**
 * @typedef {Object} ExcludedCase 被排除的一件案子
 * @property {string} temsis
 * @property {string} squad
 * @property {string} caseDate
 * @property {string} from 是從哪一份匯出檔裡被拿掉的（供追查）
 */

/**
 * 把兩份匯出檔裡的 OHCA 案件一次排除掉，並整理出「被排除了哪些」。
 *
 * 同一件可能兩份都有（交集那些），此時只記一次，`from` 記成兩邊都有——
 * 不去重的話，執行報告上的件數會比實際多。
 *
 * @param {{rows: Record<string, unknown>[], temsisColumn: string, squadColumn: string,
 *   caseDateColumn: string|null, label: string}[]} sources 要過濾的匯出檔
 * @param {Set<string>} excluded 要排除的 TEMSIS（整月處置勾 CPR 的案件）
 * @returns {{kept: Record<string, unknown>[][], removed: Record<string, unknown>[][],
 *   cases: ExcludedCase[], countsBySquad: Map<string, number>}}
 *   `kept` 與 `removed` 都與 `sources` 同順序。
 *   ⚠ `removed` 一定要回傳：申訴表比對還需要這些列的**發生地點與時間**，
 *   才認得出「這件申訴講的就是那件已排除的 OHCA」（見 `matchAppeals`）。
 */
export function excludeOhcaCases(sources, excluded) {
  const kept = [];
  const removed = [];
  /** @type {Map<string, ExcludedCase>} TEMSIS → 案件（跨匯出檔去重） */
  const byTemsis = new Map();

  for (const source of sources) {
    const split = splitExcluded(source.rows, source.temsisColumn, excluded);
    kept.push(split.kept);
    removed.push(split.removed);

    for (const row of split.removed) {
      const temsis = String(row[source.temsisColumn] ?? '').trim();
      const existing = byTemsis.get(temsis);
      if (existing) {
        existing.from = `${existing.from}、${source.label}`;
        continue;
      }
      byTemsis.set(temsis, {
        temsis,
        squad: String(row[source.squadColumn] ?? '').trim() || '(讀不到分隊)',
        caseDate: source.caseDateColumn
          ? String(row[source.caseDateColumn] ?? '').trim() || '(讀不到)'
          : '(讀不到)',
        from: source.label,
      });
    }
  }

  const cases = [...byTemsis.values()].sort(
    (left, right) => left.squad.localeCompare(right.squad, 'zh-Hant')
      || left.caseDate.localeCompare(right.caseDate),
  );

  const countsBySquad = new Map();
  for (const item of cases) {
    countsBySquad.set(item.squad, (countsBySquad.get(item.squad) ?? 0) + 1);
  }

  return { kept, removed, cases, countsBySquad };
}
