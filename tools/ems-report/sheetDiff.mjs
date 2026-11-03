/**
 * 兩份救護紀錄表的差異比對（**純函式**，無副作用，可單獨測試）。
 *
 * 用途（v1.54.0，使用者 2026-11-03 指定）：解鎖前備份的那份 vs 結案後的那份，條列出「哪裡不同」。
 *
 * ⚠ v1.54.2 起**依頁面座標比對**，不再逐行比對文字。
 *   2026-11-03 看過實際取樣（`sheet-sample`，已遮蔽）才知道：救護紀錄PDF(桃) 是**整頁轉 90 度的表格**，
 *   照文字順序讀的話，前面一大段全是標籤、所有填的值擠在後面一團——逐行比對再「往上找標籤」，
 *   姓名、身分證的變動會全部歸到錯的欄位。
 *
 * 作法：
 *   1. 兩份都取出「每一段文字＋座標」（`extractPdfItems`），換成**閱讀座標**（列＝由上往下、欄＝由左往右；
 *      依文字前進方向自動判斷，轉 90 度的頁面也一樣）
 *   2. 同一頁、同一位置的兩段配成一對；文字不同＝改了，配不到＝新增或刪除
 *   3. 判斷是哪一欄——**只認設定檔裡的固定標籤**（`UNLOCK.revision.layoutLabels`，取自實際表格）：
 *      - 同一列、前面最近的標籤（`傷病患姓名　王小明`）
 *      - 找不到就找上方表頭（`到達現場時間` 下面那格；生命徵象一欄標籤對三欄數值）
 *      - 都找不到就找附近的標籤，只能說「附近」
 *      不拿「兩份都沒變的字」當標籤：沒改過的姓名也是兩份都一樣，拿它當標籤就會被寫上雲端。
 *   4. 勾選框：`□ 保暖` → `■ 保暖`（記號與選項同一段），或單獨一個 `□` → `■`（選項在旁邊）
 *
 * 產出兩種版本：
 *   - **本機版**：完整的改前改後（含病患資料，只寫進 `out/internal/`）
 *   - **雲端版**：只寫欄位名；勾選框只寫「哪個區塊的勾選有更動」，不寫勾了哪一項（那本身就是病歷內容）；
 *     只有白名單欄位（時間、檢傷、生命徵象）、而且值看起來只是數字或分級時，才寫改前改後
 */

/**
 * @typedef {import('./pdfText.mjs').PdfTextItem} PdfTextItem
 */

/**
 * @typedef {Object} SheetChange 一處不同
 * @property {'value'|'checkbox'} kind 填的值改了／勾選改了
 * @property {string[]} before 解鎖前那幾段文字（未遮蔽）
 * @property {string[]} after 結案後那幾段文字
 * @property {string[]} fields 判斷出的欄位（可能為空）
 * @property {'inline'|'nearby'|'unknown'} fieldSource
 *   `inline`＝同一列前面的標籤或正上方的表頭（可信）；`nearby`＝只是附近的標籤
 * @property {{label: string, before: string, after: string}[]} segments 各欄位改前改後的值（`inline` 時才有）
 * @property {string|null} option 勾選框的選項文字（本機報告用；可能就是病歷內容，不上雲）
 */

/**
 * @typedef {Object} DiffConfig 比對設定（對應 `UNLOCK.revision`）
 * @property {string[]} layoutLabels 表格上印好的欄位標籤（實際取樣而來）
 * @property {Record<string, string>} [labelNames] 標籤的顯示名稱（`M` → `GCS-M`）
 * @property {string[]} sensitiveLabels 個資欄位（包含比對）
 * @property {string[]} cloudValueLabels 雲端可以寫出內容的欄位（完全相等）
 * @property {number} cloudMaxItems
 * @property {number} cloudMaxValueLength
 * @property {{matchTolerance: number, rowTolerance: number, sameRowMaxGap: number,
 *   headerMaxGap: number, headerColTolerance: number, nearbyMaxDistance: number,
 *   optionMaxGap: number, regions?: {label: string, rowFrom: number, rowTo: number,
 *   colFrom: number, colTo: number}[]}} layout 版面判斷的距離（pt）與固定區塊
 */

/** 勾選框記號。 */
const CHECKBOX_MARKS = /[□■☐☑☒✓✔]/;

/** 比對用的鍵：壓掉空白、去掉結尾冒號、轉大寫。 */
function labelKey(text) {
  return String(text ?? '').replace(/[\s　]+/g, '').replace(/[:：]+$/, '').toUpperCase();
}

/** 顯示用的標籤：整理空白、去掉結尾冒號，**大小寫照原樣**（比對才用 `labelKey`）。 */
function displayLabel(text) {
  return String(text ?? '').replace(/[\s　]+/g, ' ').trim().replace(/[:：]+$/, '');
}

/**
 * 換成閱讀座標：`row` 由上往下增加、`col` 由左往右增加。
 *
 * 文字前進方向就是「欄」的方向；把它順時針轉 90 度就是「往下」。
 * 一般橫書 (1,0) → 往下＝(0,-1)，所以 row＝-y；轉 90 度的頁面 (0,1) → 往下＝(1,0)，row＝x。
 *
 * @param {PdfTextItem} item
 * @returns {{row: number, col: number}}
 */
export function toReadingFrame(item) {
  const dirX = item.dirX ?? 1;
  const dirY = item.dirY ?? 0;
  return {
    col: item.x * dirX + item.y * dirY,
    row: item.x * dirY - item.y * dirX,
  };
}

/** 這段是不是只有勾選記號（`□`、`■`）。 */
export function isLoneCheckbox(text) {
  const trimmed = String(text ?? '').replace(/[\s　]+/g, '');
  return trimmed !== '' && [...trimmed].every((char) => CHECKBOX_MARKS.test(char));
}

/** 勾選框那段去掉記號後的選項文字（`■ 保暖` → `保暖`）；沒有記號回傳 null。 */
export function checkboxOption(text) {
  const value = String(text ?? '');
  if (!CHECKBOX_MARKS.test(value)) return null;
  const option = value.replace(new RegExp(CHECKBOX_MARKS.source, 'g'), '').replace(/[\s　]+/g, ' ').trim();
  return option || null;
}

/** 加上閱讀座標，方便後面算距離。 */
function withFrame(items) {
  return items.map((item) => ({ ...item, ...toReadingFrame(item) }));
}

/**
 * 同一頁、同一位置的兩段配成一對（純函式）。
 *
 * @param {ReturnType<typeof withFrame>} before
 * @param {ReturnType<typeof withFrame>} after
 * @param {number} tolerance
 * @returns {{pairs: {before: object, after: object}[], removed: object[], added: object[]}}
 */
export function matchItems(before, after, tolerance) {
  const used = new Set();
  const pairs = [];
  const removed = [];
  for (const item of before) {
    let best = -1;
    let bestDistance = Infinity;
    after.forEach((candidate, index) => {
      if (used.has(index) || candidate.page !== item.page) return;
      const distance = Math.hypot(candidate.row - item.row, candidate.col - item.col);
      // 同位置有好幾段時，優先配文字一樣的（同一格常被拆成好幾段）。
      const score = distance + (candidate.str === item.str ? 0 : 0.5);
      if (distance <= tolerance && score < bestDistance) {
        best = index;
        bestDistance = score;
      }
    });
    if (best === -1) removed.push(item);
    else {
      used.add(best);
      pairs.push({ before: item, after: after[best] });
    }
  }
  const added = after.filter((_item, index) => !used.has(index));
  return { pairs, removed, added };
}

/**
 * 表格上的固定標籤（只認設定檔列的，**不**拿兩份都沒變的字當標籤）。
 * @returns {ReturnType<typeof withFrame>}
 */
function findLayoutLabels(items, labels) {
  const wanted = new Set(labels.map(labelKey));
  return items.filter((item) => wanted.has(labelKey(item.str)));
}

/**
 * 這一格屬於哪個標籤。
 *
 * @param {{row: number, col: number, page: number}} cell
 * @param {ReturnType<typeof withFrame>} labels
 * @param {DiffConfig['layout']} layout
 * @returns {{label: string|null, source: 'inline'|'nearby'|'unknown'}}
 */
export function attributeCell(cell, labels, layout) {
  // 0. 固定區塊（例如補述欄的內容）：位置落在範圍裡就是它
  const region = (layout.regions ?? []).find((area) => cell.row >= area.rowFrom && cell.row <= area.rowTo
    && cell.col >= area.colFrom && cell.col <= area.colTo);
  if (region) return { label: region.label, source: 'inline' };
  const onPage = labels.filter((label) => label.page === cell.page);
  // 1. 同一列、在它前面、最近的標籤
  const sameRow = onPage
    .filter((label) => Math.abs(label.row - cell.row) <= layout.rowTolerance
      && label.col < cell.col && cell.col - label.col <= layout.sameRowMaxGap)
    .sort((left, right) => right.col - left.col)[0];
  if (sameRow) return { label: displayLabel(sameRow.str), source: 'inline' };
  // 2. 正上方的表頭（欄位差不多對齊，往上最近的那一個）
  const header = onPage
    .filter((label) => label.row < cell.row && cell.row - label.row <= layout.headerMaxGap
      && Math.abs(label.col - cell.col) <= layout.headerColTolerance)
    .sort((left, right) => right.row - left.row)[0];
  if (header) return { label: displayLabel(header.str), source: 'inline' };
  // 3. 附近（只能說在附近）
  const nearby = onPage
    .map((label) => ({ label, distance: Math.hypot(label.row - cell.row, label.col - cell.col) }))
    .filter((entry) => entry.distance <= layout.nearbyMaxDistance)
    .sort((left, right) => left.distance - right.distance)[0];
  if (nearby) return { label: displayLabel(nearby.label.str), source: 'nearby' };
  return { label: null, source: 'unknown' };
}

/** 單獨一個勾選框旁邊的選項文字（同一列、後面最近的一段；本機報告用）。 */
function optionNextTo(cell, items, layout) {
  const next = items
    .filter((item) => item.page === cell.page && !isLoneCheckbox(item.str)
      && Math.abs(item.row - cell.row) <= layout.rowTolerance
      && item.col > cell.col && item.col - cell.col <= layout.optionMaxGap)
    .sort((left, right) => left.col - right.col)[0];
  return next ? next.str.trim() : null;
}

/**
 * 一段改動（配對成功但文字不同、或只出現在一邊）寫成一處不同。
 *
 * @param {{before: object|null, after: object|null}} diff
 * @param {{labels: object[], items: object[], config: DiffConfig}} context
 * @returns {SheetChange}
 */
function describeCell(diff, context) {
  const cell = diff.after ?? diff.before;
  const beforeText = diff.before?.str ?? '';
  const afterText = diff.after?.str ?? '';
  const isCheckbox = CHECKBOX_MARKS.test(beforeText) || CHECKBOX_MARKS.test(afterText);
  if (isCheckbox) {
    // 勾選框**不猜區塊**：實際版面同一列橫跨好幾個區塊，猜出來的區塊常常是錯的
    // （2026-11-03 用取樣驗證：「霧化吸入型面罩」被歸到「傷病患財物明細」）。
    // 選項文字（`■ 保暖` 的「保暖」，或單獨 `□` 旁邊那個字）準得多，直接寫進本機報告。
    const option = checkboxOption(afterText) ?? checkboxOption(beforeText)
      ?? optionNextTo(cell, context.items, context.config.layout);
    return {
      kind: 'checkbox', before: [beforeText], after: [afterText], fields: [], fieldSource: 'unknown', segments: [], option,
    };
  }
  const attributed = attributeCell(cell, context.labels, context.config.layout);
  const source = attributed.source;
  const label = attributed.label ? context.config.labelNames?.[attributed.label] ?? attributed.label : null;
  const fields = label ? [label] : [];
  const segments = label && source === 'inline'
    ? [{ label, before: beforeText.trim(), after: afterText.trim() }]
    : [];
  return { kind: 'value', before: [beforeText], after: [afterText], fields, fieldSource: source, segments, option: null };
}

/**
 * 同一欄被拆成好幾段（地址、主訴常常這樣）時合成一處，報告才不會一欄寫好幾條。
 * @param {SheetChange[]} changes
 * @returns {SheetChange[]}
 */
function mergeByField(changes) {
  const merged = [];
  const byKey = new Map();
  for (const change of changes) {
    const key = change.kind === 'value' && change.fieldSource === 'inline' ? change.fields[0] : null;
    if (!key || !byKey.has(key)) {
      if (key) byKey.set(key, change);
      merged.push(change);
      continue;
    }
    const target = byKey.get(key);
    target.before.push(...change.before);
    target.after.push(...change.after);
    target.segments[0].before = target.before.filter(Boolean).join(' ').trim();
    target.segments[0].after = target.after.filter(Boolean).join(' ').trim();
  }
  return merged;
}

/**
 * 比對兩份紀錄表（依座標），列出每一處不同。
 *
 * @param {PdfTextItem[]} beforeItems 解鎖前（備份）
 * @param {PdfTextItem[]} afterItems 結案後
 * @param {DiffConfig} config
 * @returns {SheetChange[]} 沒有不同時為空陣列
 */
export function describeChanges(beforeItems, afterItems, config) {
  const keep = (item) => String(item.str ?? '').trim() !== '';
  const before = withFrame(beforeItems.filter(keep));
  const after = withFrame(afterItems.filter(keep));
  const { pairs, removed, added } = matchItems(before, after, config.layout.matchTolerance);
  // 標籤從結案後那份找（兩份是同一個範本，位置一樣）；找不到再看解鎖前那份。
  const labels = findLayoutLabels(after.length > 0 ? after : before, config.layoutLabels);
  const context = { labels, items: after, config };
  const diffs = [
    ...pairs
      .filter((pair) => pair.before.str.replace(/[\s　]+/g, '') !== pair.after.str.replace(/[\s　]+/g, ''))
      .map((pair) => ({ before: pair.before, after: pair.after })),
    ...removed.map((item) => ({ before: item, after: null })),
    ...added.map((item) => ({ before: null, after: item })),
  ].sort((left, right) => {
    const a = left.after ?? left.before;
    const b = right.after ?? right.before;
    return a.page - b.page || a.row - b.row || a.col - b.col;
  });
  return mergeByField(diffs.map((diff) => describeCell(diff, context)));
}

/** 這個欄位是不是個資欄位（包含比對：`身分證` 也認得 `國民身分證統一編號`）。 */
function isSensitiveLabel(label, sensitiveLabels) {
  const key = labelKey(label);
  return sensitiveLabels.some((sensitive) => key.includes(labelKey(sensitive)));
}

/**
 * 雲端可以寫出來的值：只有數字、時間、血壓、分級這類寫法。
 *
 * 最後一道防線：就算欄位判斷錯了、把姓名當成「到院時間」那一格，姓名也過不了這個樣式。
 */
const CLOUD_SAFE_VALUE = /^[0-9０-９:：/／\-.．,，%％°℃()（）~～\sA-Za-z第一二三四五六級次分鐘下秒度]*$/;

/** 把一段值整理成雲端可以顯示的樣子；不安全就回傳 null。 */
function toCloudValue(value, maxLength) {
  const text = String(value ?? '');
  if (text.length > maxLength) return null;
  if (!CLOUD_SAFE_VALUE.test(text)) return null;
  // 字母只允許計量單位這種短寫法（mmHg、bpm、E4V5M6），連續 5 個以上就不是了。
  if (/[A-Za-z]{5,}/.test(text)) return null;
  // 5 碼以上的數字（身分證、電話、病歷號的一部分）一律遮掉。
  return text.replace(/\d{5,}/g, '#####') || '（空白）';
}

/**
 * 一處填值的改動寫成雲端的一句話（不含病患資料）；勾選框另外處理。
 * @returns {string}
 */
function describeValueForCloud(change, config) {
  const names = change.fields.map((field) => `「${field}」`).join('');
  if (change.fieldSource === 'nearby') return `${names}附近的內容有更動`;
  return change.segments.map((segment) => {
    const showable = config.cloudValueLabels.map(labelKey).includes(labelKey(segment.label))
      && !isSensitiveLabel(segment.label, config.sensitiveLabels);
    if (!showable) return `更正「${segment.label}」`;
    const before = toCloudValue(segment.before, config.cloudMaxValueLength);
    const after = toCloudValue(segment.after, config.cloudMaxValueLength);
    if (before === null || after === null) return `更正「${segment.label}」`;
    return `「${segment.label}」${before} → ${after}`;
  }).join('、');
}

/**
 * 雲端版的差異摘要（網頁工單上顯示用，**不含病患資料**）。
 *
 * - 填值：同一欄只寫一次
 * - 勾選框：合成一句「有 N 個勾選項目有更動」，**不寫勾了哪一項**（那本身就是病歷內容）
 * - 判斷不出欄位的：合成一句「有 N 處」
 *
 * @param {SheetChange[]} changes
 * @param {DiffConfig} config
 * @returns {{items: string[], changeCount: number}}
 */
export function toCloudItems(changes, config) {
  const items = [];
  let unknownValues = 0;
  let checkboxes = 0;
  for (const change of changes) {
    if (change.kind === 'checkbox') checkboxes += 1;
    else if (change.fieldSource === 'unknown') unknownValues += 1;
    else items.push(describeValueForCloud(change, config));
  }
  if (checkboxes > 0) items.push(`有 ${checkboxes} 個勾選項目有更動（勾了哪些詳見本機報告）`);
  if (unknownValues > 0) items.push(`有 ${unknownValues} 處內容不同（未能判斷是哪一欄，詳見本機報告）`);
  const unique = [...new Set(items)];
  if (unique.length <= config.cloudMaxItems) return { items: unique, changeCount: changes.length };
  const shown = unique.slice(0, config.cloudMaxItems - 1);
  return {
    items: [...shown, `另有 ${unique.length - shown.length} 項不同（詳見本機報告）`],
    changeCount: changes.length,
  };
}

/**
 * 本機版的差異報告（**含病患資料**，只能寫進 `out/internal/`）。
 *
 * @param {{temsis: string, caseDate: string|null, vehicle: string|null, squad: string|null,
 *   remark: string, unlockedAt: string, comparedAt: string, backupFile: string, closedFile: string}} meta
 * @param {SheetChange[]} changes
 * @param {{reportMaxLineLength: number}} config
 * @returns {string}
 */
export function formatLocalReport(meta, changes, config) {
  const clip = (line) => (line.length > config.reportMaxLineLength
    ? `${line.slice(0, config.reportMaxLineLength)}…（後面省略）`
    : line);
  const show = (parts) => clip(parts.filter(Boolean).join(' ').trim()) || '（空白）';
  const vehicle = meta.vehicle ? `${meta.vehicle}${meta.squad ? `（${meta.squad}）` : ''}` : meta.squad ?? '（讀不到）';
  const lines = [
    '救護紀錄表：解鎖前 vs 結案後 差異清單',
    '※ 本檔含病患資料，只供救護科內部核對，請勿外傳。',
    '',
    `TEMSIS：${meta.temsis}`,
    `案件日期：${meta.caseDate ?? '（讀不到）'}　出勤車輛：${vehicle}`,
    `解鎖前：${meta.remark}（解鎖時間 ${meta.unlockedAt}）　檔案：${meta.backupFile}`,
    `結案後：比對時間 ${meta.comparedAt}　檔案：${meta.closedFile}`,
    '',
  ];
  if (changes.length === 0) {
    lines.push('兩份內容相同：解鎖之後沒有改動任何內容。');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`共 ${changes.length} 處不同：`, '');
  for (const [position, change] of changes.entries()) {
    const where = change.fieldSource === 'unknown'
      ? '未能判斷欄位'
      : `${change.fields.join('、')}${change.fieldSource === 'nearby' ? '（附近）' : ''}`;
    if (change.kind === 'checkbox') {
      lines.push(`${position + 1}. 〔勾選〕${change.option ? `「${change.option}」` : '（認不出是哪一項）'}`);
    } else {
      lines.push(`${position + 1}. 〔${where}〕`);
    }
    lines.push(`   解鎖前：${show(change.before)}`);
    lines.push(`   結案後：${show(change.after)}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
