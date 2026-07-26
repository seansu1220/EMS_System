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

/**
 * 從匯出檔的欄位標題中找出「分隊」欄。
 * @param {string[]} headers 匯出檔的欄位標題
 * @param {readonly string[]} candidates 可能的欄名（依序比對）
 * @returns {string} 實際使用的欄名
 */
export function resolveSquadColumn(headers, candidates) {
  const normalize = (text) => String(text ?? '').replace(/\s/g, '');
  const normalizedHeaders = headers.map(normalize);

  for (const candidate of candidates) {
    const index = normalizedHeaders.indexOf(normalize(candidate));
    if (index >= 0) return headers[index];
  }
  // 找不到完全相同的欄名時，退而求其次找「包含」候選字的欄位。
  for (const candidate of candidates) {
    const index = normalizedHeaders.findIndex((header) => header.includes(normalize(candidate)));
    if (index >= 0) return headers[index];
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
