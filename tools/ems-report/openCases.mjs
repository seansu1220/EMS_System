/**
 * 未結案案件統整（第 9 章）的**判斷規則**——全部是純函式，不碰瀏覽器。
 *
 * 頁面操作在 `openCasesFlow.mjs`，報表輸出在 `openCasesReport.mjs`；
 * 「怎麼統整、怎麼算件數」集中在這裡，才寫得了測試釘住。
 *
 * 名詞：
 *   - **紀錄表**：一台車出勤一張，查詢頁「救護狀態＝未結案」撈出來的是紀錄表
 *   - **案件**：同一個指派案號底下的所有紀錄表（一件案子出動幾台車就有幾張）
 */
import { OPEN_CASES } from './config.mjs';

/**
 * @typedef {Object} RecordLookup 一張未結案紀錄表查回指派案號的結果
 * @property {string} temsis
 * @property {string} squad 匯出檔上的出勤單位
 * @property {string} caseDate 匯出檔上的案件日期（讀不到為空字串）
 * @property {string|null} dispatchNo 指派案號；讀不到為 null
 * @property {string|null} error 讀不到的原因；成功為 null
 */

/**
 * @typedef {Object} CaseRecordRow 案件內部表格的一列（一張紀錄表）
 * @property {string} itemNo 項次
 * @property {string} date 日期
 * @property {string} vehicle 派遣車輛
 * @property {string} squad 派遣分隊
 * @property {string} status 救護表狀態
 */

/**
 * @typedef {Object} CaseInspection 一件案子進案件內部讀到的結果
 * @property {string} dispatchNo
 * @property {CaseRecordRow[]} rows
 * @property {number} buttonCount 案件內部「救護紀錄」按鈕的數量（拿來和讀到的列數互相核對）
 * @property {number} caseListRows 案件列表以這個案號查到幾筆（照理是 1）
 * @property {string|null} error 進不去或讀不到時的原因；成功為 null
 */

/**
 * @typedef {Object} CaseSummary 報表上的一件案子
 * @property {string} dispatchNo
 * @property {string} caseDate
 * @property {string[]} squads 派遣分隊（去重，依出現順序）
 * @property {number} recordCount 紀錄表張數
 * @property {string} statusText 例如 `已結案*1+已填寫*2+未填寫*1`
 * @property {boolean|null} hasClosed 有沒有任何一張已結案；讀取失敗時為 null（不知道）
 * @property {string[]} vehiclesWithoutClosed 這件案子裡**一張已結案都沒有的車**
 *   （同一台車有好幾張時，任一張已結案就不算）；讀取失敗時為空陣列，以 `hasClosed === null` 分辨
 * @property {string[]} openTemsis 這件案子裡被「未結案」查詢撈到的那幾張的 TEMSIS
 * @property {CaseRecordRow[]} records 案件內部讀到的每一張紀錄表（報表的明細分頁用）
 * @property {string[]} notes 要人留意的事（列數對不上、案件列表查到多筆…）
 * @property {string|null} error
 */

/** 比對用：去掉所有空白（系統的表格文字常夾著換行與全形空白）。 */
export function normalizeStatus(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/**
 * 把一件案子各張紀錄表的狀態統整成一句話。
 *
 * 排列順序照 `order`，不在清單上的狀態排在最後並**原樣寫出**——
 * 系統哪天多了一種狀態，報表上照樣看得到，不會被默默吞掉。
 *
 * @param {string[]} statuses 每一張紀錄表的救護表狀態
 * @param {readonly string[]} [order]
 * @returns {{counts: {status: string, count: number}[], text: string}}
 *   `text` 例如 `已結案*1+已填寫*2+未填寫*1`；一張都沒有時為空字串
 */
export function summarizeStatuses(statuses, order = OPEN_CASES.statusOrder) {
  const tally = new Map();
  for (const raw of statuses) {
    const status = normalizeStatus(raw) || '（空白）';
    tally.set(status, (tally.get(status) ?? 0) + 1);
  }
  const rank = (status) => {
    const index = order.indexOf(status);
    return index < 0 ? order.length : index;
  };
  const counts = [...tally.entries()]
    .map(([status, count]) => ({ status, count }))
    // 同樣不在清單上的，維持第一次出現的順序（sort 是穩定的）。
    .sort((left, right) => rank(left.status) - rank(right.status));
  return { counts, text: counts.map((item) => `${item.status}*${item.count}`).join('+') };
}

/**
 * 這件案子有沒有任何一張已結案。
 * @param {string[]} statuses
 * @param {string} [closedStatus]
 * @returns {boolean}
 */
export function hasClosedRecord(statuses, closedStatus = OPEN_CASES.closedStatus) {
  const wanted = normalizeStatus(closedStatus);
  return statuses.some((status) => normalizeStatus(status) === wanted);
}

/** 案件內部讀不到派遣車輛時，那幾張歸在這一台底下（不猜是哪台）。 */
export const UNKNOWN_VEHICLE = '（車輛讀不到）';

/**
 * 找出案件裡**一張已結案都沒有的車**（使用者 2026-10-05 要的「依車輛」細篩）。
 *
 * 為什麼要以車為單位：同一台車常有兩張紀錄表（例如「已結案＋已填寫」，像是多開了一張），
 * 只要其中一張已結案，那台車就算結了；反過來，整件案子有別台車結案，
 * 不代表**每一台**都結了——只看整件案子會把這種漏掉。
 *
 * @param {CaseRecordRow[]} rows
 * @returns {string[]} 沒有已結案的車（依第一次出現的順序）
 */
export function findVehiclesWithoutClosed(rows) {
  const byVehicle = new Map();
  for (const row of rows) {
    const vehicle = String(row.vehicle ?? '').trim() || UNKNOWN_VEHICLE;
    byVehicle.set(vehicle, [...(byVehicle.get(vehicle) ?? []), row.status]);
  }
  return [...byVehicle.entries()]
    .filter(([, statuses]) => !hasClosedRecord(statuses))
    .map(([vehicle]) => vehicle);
}

/**
 * 把查回指派案號的紀錄表依案號分組（同一件案子的幾台車只要進一次案件內部）。
 *
 * 讀不到案號的不在這裡面——它們進不了案件內部，會另外列在報表的失敗清單上。
 *
 * @param {RecordLookup[]} lookups
 * @returns {Map<string, {temsisList: string[], caseDate: string, squads: string[]}>}
 *   依第一次出現的順序排列
 */
export function groupByDispatchNo(lookups) {
  const groups = new Map();
  for (const lookup of lookups) {
    if (!lookup.dispatchNo) continue;
    const group = groups.get(lookup.dispatchNo)
      ?? { temsisList: [], caseDate: lookup.caseDate, squads: [] };
    group.temsisList.push(lookup.temsis);
    if (!group.caseDate && lookup.caseDate) group.caseDate = lookup.caseDate;
    if (lookup.squad && !group.squads.includes(lookup.squad)) group.squads.push(lookup.squad);
    groups.set(lookup.dispatchNo, group);
  }
  return groups;
}

/**
 * 把一件案子的讀取結果整理成報表上的一列。
 *
 * @param {CaseInspection} inspection
 * @param {{temsisList: string[], caseDate: string, squads: string[]}} group 這件案子在未結案清單裡的那幾張
 * @returns {CaseSummary}
 */
export function buildCaseSummary(inspection, group) {
  const base = {
    dispatchNo: inspection.dispatchNo,
    caseDate: group.caseDate,
    openTemsis: [...group.temsisList],
  };
  if (inspection.error) {
    return {
      ...base,
      squads: [...group.squads],
      recordCount: 0,
      statusText: '',
      hasClosed: null,
      vehiclesWithoutClosed: [],
      records: [],
      notes: [],
      error: inspection.error,
    };
  }

  const statuses = inspection.rows.map((row) => row.status);
  const notes = [];
  // 讀到的列數與「救護紀錄」按鈕數對不上，代表有列沒讀到（例如狀態欄空白被略過），
  // 統整出來的數字就可能少算——照實寫出來，不假裝沒事。
  if (inspection.buttonCount > 0 && inspection.buttonCount !== inspection.rows.length) {
    notes.push(`案件內部有 ${inspection.buttonCount} 個紀錄表按鈕，但只讀到 ${inspection.rows.length} 列狀態`);
  }
  if (inspection.caseListRows > 1) {
    notes.push(`案件列表有 ${inspection.caseListRows} 列的案號都是這一號，取第一列統整，請自行確認`);
  }
  const squadsInCase = inspection.rows.map((row) => row.squad).filter(Boolean);
  return {
    ...base,
    // 匯出檔沒有案件日期欄時，退回案件內部第一張紀錄表的日期，報表才排得了序。
    caseDate: group.caseDate || inspection.rows.find((row) => row.date)?.date || '',
    // 案件內部讀到的派遣分隊比較完整（含已結案、沒被撈到的那幾台），讀不到才用清單上的。
    squads: [...new Set(squadsInCase.length > 0 ? squadsInCase : group.squads)],
    recordCount: inspection.rows.length,
    statusText: summarizeStatuses(statuses).text,
    hasClosed: hasClosedRecord(statuses),
    vehiclesWithoutClosed: findVehiclesWithoutClosed(inspection.rows),
    records: inspection.rows,
    notes,
    error: null,
  };
}

/**
 * 整份統整的數字。
 *
 * 兩個「沒結案」的數字都**以案件為單位**：
 *   - `withoutClosed`：整件案子連一張已結案都沒有
 *   - `withUnclosedVehicle`：案件裡**不是每一台車都有已結案**（含上一種，是它的上位集合）
 *
 * 只算**讀得到**的案件：讀取失敗的那幾件不知道答案，算進哪一邊都是猜，另外報一個數字。
 *
 * @param {CaseSummary[]} summaries
 * @returns {{caseCount: number, inspected: number, withoutClosed: number, withClosed: number,
 *   withUnclosedVehicle: number, failed: number}}
 */
export function countSummaries(summaries) {
  const inspected = summaries.filter((item) => item.hasClosed !== null);
  const withoutClosed = inspected.filter((item) => item.hasClosed === false).length;
  const withUnclosedVehicle = inspected
    .filter((item) => (item.vehiclesWithoutClosed ?? []).length > 0).length;
  return {
    caseCount: summaries.length,
    inspected: inspected.length,
    withoutClosed,
    withClosed: inspected.length - withoutClosed,
    withUnclosedVehicle,
    failed: summaries.length - inspected.length,
  };
}

/**
 * 從匯出檔的資料列組出「要查指派案號」的紀錄表清單（去掉重複與空白的 TEMSIS）。
 *
 * @param {Record<string, unknown>[]} rows
 * @param {{temsis: string, squad: string|null, caseDate: string|null}} columns 各欄的欄名
 * @returns {{temsis: string, squad: string, caseDate: string}[]}
 */
export function buildRecordList(rows, columns) {
  const seen = new Set();
  const list = [];
  for (const row of rows) {
    const temsis = String(row[columns.temsis] ?? '').trim();
    if (!temsis || seen.has(temsis)) continue;
    seen.add(temsis);
    list.push({
      temsis,
      squad: columns.squad ? String(row[columns.squad] ?? '').trim() : '',
      caseDate: columns.caseDate ? String(row[columns.caseDate] ?? '').trim() : '',
    });
  }
  return list;
}

/**
 * 續跑時哪幾筆可以直接沿用（只沿用**成功**的；失敗的要再試一次）。
 *
 * @param {{savedAt?: string, rangeLabel?: string}} progress 讀回來的進度檔
 * @param {string} rangeLabel 這次的查詢期間
 * @param {number} now 現在時間（毫秒，可注入以便測試）
 * @param {number} [maxAgeMs]
 * @returns {boolean} 進度檔能不能用
 */
export function isProgressUsable(progress, rangeLabel, now, maxAgeMs = OPEN_CASES.progressMaxAgeMs) {
  if (!progress || progress.rangeLabel !== rangeLabel) return false;
  const savedAt = Date.parse(progress.savedAt ?? '');
  if (Number.isNaN(savedAt)) return false;
  return now - savedAt <= maxAgeMs;
}
