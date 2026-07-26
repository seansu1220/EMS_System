/**
 * 分隊彙總統計 —— 全部是純函式（輸入 → 輸出，無副作用、不碰檔案），可單獨測試。
 *
 * ⚠ 個資原則：本模組只做「計數」。輸入雖然是個案明細，輸出一律只有
 *   分隊名稱與筆數，不保留任何個人欄位。
 */

/**
 * @typedef {Object} SquadStat
 * @property {string} squad      分隊名稱
 * @property {number} totalCount 總案件數
 * @property {number} alertCount 到院前預警案件數
 * @property {number|null} ratio 預警比率（0~1）；總案件數為 0 時為 null
 */

/** 分隊名稱的樣態：桃園市的救護單位名稱以分隊／大隊／中隊結尾。 */
const SQUAD_NAME_PATTERN = /(分隊|大隊|中隊)$/;

/** 判定「這一欄的內容看起來就是分隊」所需的比例。 */
const CONTENT_MATCH_THRESHOLD = 0.8;

const normalize = (text) => String(text ?? '').replace(/\s/g, '');

/**
 * 依「欄位內容」評分：值大多以分隊／大隊結尾者，就是分隊欄。
 * @returns {{header: string, score: number, distinct: number}[]} 由高分到低分
 */
function scoreHeadersByContent(headers, rows) {
  return headers
    .map((header) => {
      const values = rows.map((row) => String(row[header] ?? '').trim()).filter(Boolean);
      if (values.length === 0) return { header, score: 0, distinct: 0 };
      const hits = values.filter((value) => SQUAD_NAME_PATTERN.test(value)).length;
      return { header, score: hits / values.length, distinct: new Set(values).size };
    })
    .sort((left, right) => right.score - left.score || right.distinct - left.distinct);
}

/**
 * 找出匯出檔中的「分隊」欄。
 *
 * 以**內容**為主要依據而非欄名：匯出檔裡可能同時存在「分隊 自行受理」這種
 * 名稱含「分隊」卻只是勾選記號的欄位，單靠欄名比對會選錯
 * （曾因此把整份報表算成只有一個叫「V」的分隊）。
 *
 * @param {string[]} headers 匯出檔的欄位標題
 * @param {Record<string, unknown>[]} rows 資料列（用來判斷欄位內容）
 * @param {readonly string[]} candidates 備用的欄名候選
 * @returns {{column: string, reason: string}} 選中的欄名與判定依據
 */
export function resolveSquadColumn(headers, rows, candidates) {
  const scored = scoreHeadersByContent(headers, rows);
  const best = scored[0];
  if (best && best.score >= CONTENT_MATCH_THRESHOLD && best.distinct > 1) {
    return {
      column: best.header,
      reason: `內容有 ${(best.score * 100).toFixed(0)}% 以分隊／大隊結尾，共 ${best.distinct} 種`,
    };
  }

  // 內容判斷不出來（例如資料很少）時，退回欄名比對。
  const normalizedHeaders = headers.map(normalize);
  for (const candidate of candidates) {
    const index = normalizedHeaders.indexOf(normalize(candidate));
    if (index >= 0) return { column: headers[index], reason: `欄名與「${candidate}」完全相符` };
  }
  // 最後才用「包含」比對，並取最短的欄名（避免選到「分隊 自行受理」這種複合欄）。
  const contains = headers
    .filter((header) => candidates.some((candidate) => normalize(header).includes(normalize(candidate))))
    .sort((left, right) => normalize(left).length - normalize(right).length);
  if (contains.length > 0) {
    return { column: contains[0], reason: '欄名包含分隊字樣（推測，請確認結果是否合理）' };
  }

  throw new Error(
    `匯出檔中找不到分隊欄位。實際欄位有：${headers.join('、')}。` +
      `請把正確欄名加進 config.mjs 的 SQUAD_COLUMN_CANDIDATES。`,
  );
}

/**
 * 依分隊計算案件數。
 * @param {Record<string, unknown>[]} rows 匯出檔的資料列
 * @param {string} squadColumn 分隊欄名
 * @returns {Map<string, number>} 分隊 → 案件數
 */
export function countBySquad(rows, squadColumn) {
  const counts = new Map();
  for (const row of rows) {
    const squad = String(row[squadColumn] ?? '').trim();
    if (!squad) continue; // 空白列（匯出檔常見的表尾合計或空行）不列入
    counts.set(squad, (counts.get(squad) ?? 0) + 1);
  }
  return counts;
}

/**
 * 合併兩份計數，產生各分隊的比較結果。
 * 依總案件數由多到少排序，數量相同則依分隊名稱排序，確保每次輸出順序一致。
 *
 * @param {Map<string, number>} totalCounts 總案件數
 * @param {Map<string, number>} alertCounts 到院前預警案件數
 * @returns {SquadStat[]}
 */
export function buildComparison(totalCounts, alertCounts) {
  const squads = new Set([...totalCounts.keys(), ...alertCounts.keys()]);
  return [...squads]
    .map((squad) => {
      const totalCount = totalCounts.get(squad) ?? 0;
      const alertCount = alertCounts.get(squad) ?? 0;
      return { squad, totalCount, alertCount, ratio: totalCount === 0 ? null : alertCount / totalCount };
    })
    .sort((left, right) =>
      right.totalCount - left.totalCount || left.squad.localeCompare(right.squad, 'zh-Hant'),
    );
}

/**
 * 計算全部分隊的合計。
 * @param {SquadStat[]} stats
 * @returns {SquadStat}
 */
export function summarize(stats) {
  const totalCount = stats.reduce((sum, item) => sum + item.totalCount, 0);
  const alertCount = stats.reduce((sum, item) => sum + item.alertCount, 0);
  return {
    squad: '合計',
    totalCount,
    alertCount,
    ratio: totalCount === 0 ? null : alertCount / totalCount,
  };
}

/**
 * 比率轉成顯示用字串。
 * @param {number|null} ratio
 * @returns {string}
 */
export function formatRatio(ratio) {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`;
}
