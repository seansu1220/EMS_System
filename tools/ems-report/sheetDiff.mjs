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
 *      - 同一列從標籤開頭或**結尾**量都可以（長標籤後面接的值，例如指派案號）
 *      - 找不到就找上方表頭（`到達現場時間` 下面那格；生命徵象一欄標籤對三欄數值）
 *      - 生命徵象表再加上時間點（抵達現場／送醫途中／到院後，見 `vitalTimepointOf`）
 *      - 固定區塊（補述欄、受傷部位及尺寸）：位置落在範圍裡就是它
 *      - 都找不到就找附近的標籤，只能說「附近」
 *      不拿「兩份都沒變的字」當標籤：沒改過的姓名也是兩份都一樣，拿它當標籤就會被寫上雲端。
 *   4. 勾選框：`□ 保暖` → `■ 保暖`（記號與選項同一段），或單獨一個 `□` → `■`（選項在旁邊）；
 *      依位置對到區塊（`layout.checkboxGroups`），寫成「「傷病患類別」取消勾選「創傷」」
 *
 * 產出兩種版本：
 *   - **本機版**：完整的改前改後（含病患資料，只寫進 `out/internal/`）
 *   - **雲端版**：只寫欄位名；勾選框只有落在已知區塊、而且選項在印好的選項白名單（`checkboxPrintedOptions`）裡，
 *     才寫出選項與勾選／取消勾選（擋手寫內容靠白名單，不是區塊），
 *     其他勾選只寫「有 N 個勾選項目有更動」；
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
 * @property {{label: string, baseLabel?: string, before: string, after: string}[]} segments
 *   各欄位改前改後的值（`inline` 時才有）。`label` 是顯示名稱（生命徵象會加上時間點，
 *   例如「生命徵象（到院後）量測時間」）；`baseLabel` 是表上印的欄位名，雲端白名單／個資判斷用它
 * @property {string|null} option 勾選框的選項文字（已知區塊裡、而且 `optionVerified` 的才上雲，見 `toCloudItems`）
 * @property {boolean} [optionVerified] 勾選框的選項文字在兩份裡一模一樣（第二道檢查；是不是印好的字看 `checkboxPrintedOptions`）
 * @property {'checked'|'unchecked'|'changed'} [checkAction] 勾選框：勾選／取消勾選／看不出來
 * @property {boolean|null} [checkedBefore] 勾選框解鎖前有沒有勾（看不出來為 null）
 * @property {boolean|null} [checkedAfter] 勾選框結案後有沒有勾
 */

/**
 * @typedef {Object} DiffConfig 比對設定（對應 `UNLOCK.revision`）
 * @property {string[]} layoutLabels 表格上印好的欄位標籤（實際取樣而來）
 * @property {Record<string, string>} [labelNames] 標籤的顯示名稱（`M` → `GCS-M`）
 * @property {string[]} sensitiveLabels 個資欄位（包含比對）
 * @property {string[]} [sensitiveCheckboxGroups] 只寫區塊、不寫選項的勾選區塊（完全相等）
 * @property {string[]} [checkboxPrintedOptions] 表上印好的勾選選項（白名單）：雲端只寫得出這份裡的選項
 * @property {Record<string, string>} [checkboxOptionNames] 勾選選項在網頁上的顯示名稱
 * @property {string[]} cloudValueLabels 雲端可以寫出內容的欄位（完全相等）
 * @property {number} cloudMaxItems
 * @property {number} cloudMaxValueLength
 * @property {{matchTolerance: number, rowTolerance: number, sameRowMaxGap: number, sameRowEndGap?: number,
 *   sameRowEndOverlap?: number, sameRowMaxGapByLabel?: Record<string, number>,
 *   headerMaxGap: number, headerColTolerance: number, nearbyMaxDistance: number,
 *   optionMaxGap: number, regions?: {label: string, rowFrom: number, rowTo: number,
 *   colFrom: number, colTo: number}[], checkboxGroups?: {label: string, rowFrom: number, rowTo: number,
 *   colFrom: number, colTo: number}[]}} layout 版面判斷的距離（pt）、固定區塊與勾選框的區塊
 * @property {VitalSignsConfig} [vitalSigns] 生命徵象表的時間點（沒設就不加時間點）
 */

/**
 * @typedef {Object} VitalSignsConfig 生命徵象表（對應 `UNLOCK.revision.vitalSigns`）
 * @property {string} title 表名
 * @property {{label: string, name: string}[]} timepoints 表上印的時間點標籤 → 顯示名稱
 * @property {string[]} columns 這張表的欄位（換成 labelNames 之後的名稱）
 * @property {Record<string, string>} [columnNames] 欄位的顯示名稱
 * @property {number} rowAbove 一格最多在時間點標籤上方多遠
 * @property {number} rowBelow 一格最多在時間點標籤下方多遠
 * @property {number} colLead 一格最多在時間點標籤左邊多遠
 */

/** 勾選框記號。 */
const CHECKBOX_MARKS = /[□■☐☑☒✓✔]/;

/** 代表「有勾」的記號（其餘 `□☐` 是沒勾）。 */
const CHECKED_MARKS = /[■☑☒✓✔]/;

/** 「不是勾選記號」的字元（從 `CHECKBOX_MARKS` 推出，新增記號只改一處）。 */
const NOT_A_MARK = CHECKBOX_MARKS.source.replace('[', '[^');

/**
 * 一段文字裡的每個勾選框：有沒有勾、後面接的選項文字（純函式）。
 * `目擊者: □ 有` → `[{checked: false, option: '有'}]`；`□ 不識字 ■ 拒簽` → 兩個。記號前面的字（標題）不算。
 *
 * @param {string} text
 * @returns {{checked: boolean, option: string}[]}
 */
export function parseCheckboxes(text) {
  const marks = new RegExp(`(${CHECKBOX_MARKS.source})(${NOT_A_MARK}*)`, 'g');
  return [...String(text ?? '').matchAll(marks)].map((match) => ({
    checked: CHECKED_MARKS.test(match[1]),
    option: cleanOption(match[2]),
  }));
}

/**
 * 選項文字去掉頭尾的斜線、冒號，與**沒成對**的括號（`正常/` → `正常`、`右)` → `右`；
 * `BVM(正壓輔助呼吸)` 的括號成對，保留）。
 *
 * @param {string} text
 * @returns {string}
 */
function cleanOption(text) {
  let option = String(text ?? '').replace(/[\s　]+/g, ' ').trim().replace(/^[/／:：\s]+|[/／:：\s]+$/g, '');
  if (!/[(（]/.test(option)) option = option.replace(/[)）]+$/, '').trim();
  if (!/[)）]/.test(option)) option = option.replace(/^[(（]+/, '').trim();
  return option;
}

/**
 * @typedef {Object} CheckboxEdit 一個勾選框的改動
 * @property {string|null} option 選項文字（同一段裡記號後面的字；單獨一個框時為 null，由呼叫端取旁邊的字）
 * @property {'checked'|'unchecked'|'changed'} action 勾選／取消勾選／看不出來
 * @property {boolean|null} checkedBefore
 * @property {boolean|null} checkedAfter
 * @property {boolean} optionStable 選項文字兩份一模一樣（不是改過的內容；雲端另外還要在印好的選項白名單裡）
 */

/**
 * 一段勾選改了什麼（純函式）：**每個**有沒有勾不一樣的框各一筆。
 *
 * - 兩邊框數一樣：逐一比位置
 * - 框數不一樣（PDF 切段不同、新增或刪除）：依選項文字配對；只出現在一邊的，有勾才算
 * - 勾選狀態都沒變、只有字變了：回傳一筆 `changed`、選項 null——變的是文字本身，那段字不是印好的選項
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {CheckboxEdit[]} 至少一筆
 */
export function describeCheckboxEdits(beforeText, afterText) {
  const before = parseCheckboxes(beforeText);
  const after = parseCheckboxes(afterText);
  const edits = before.length === after.length
    ? after.flatMap((box, index) => (box.checked === before[index].checked ? [] : [toEdit(before[index], box)]))
    : matchBoxesByOption(before, after);
  if (edits.length > 0) return edits;
  return [{ option: null, action: 'changed', checkedBefore: null, checkedAfter: null, optionStable: false }];
}

/** 框數不一樣時依選項文字配對（純函式）。 */
function matchBoxesByOption(before, after) {
  const edits = [];
  for (const box of after) {
    const old = before.find((candidate) => candidate.option === box.option);
    if (old && old.checked !== box.checked) edits.push(toEdit(old, box));
    else if (!old && box.checked) edits.push(toEdit(null, box));
  }
  for (const box of before) {
    if (box.checked && !after.some((candidate) => candidate.option === box.option)) edits.push(toEdit(box, null));
  }
  return edits;
}

/** 一個框改前改後 → 一筆改動；`null`＝那一邊沒有這個框。 */
function toEdit(before, after) {
  const checkedBefore = before ? before.checked : null;
  const checkedAfter = after ? after.checked : null;
  const action = checkedAfter === true || (checkedAfter === null && checkedBefore === false) ? 'checked' : 'unchecked';
  return {
    option: after?.option || before?.option || null,
    action,
    checkedBefore,
    checkedAfter,
    optionStable: Boolean(before && after && before.option === after.option),
  };
}

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
  // 1. 同一列、在它前面、最近的標籤（從標籤開頭量，或從標籤結尾量，任一條成立）
  const sameRow = onPage
    .filter((label) => Math.abs(label.row - cell.row) <= layout.rowTolerance
      && label.col < cell.col && isWithinSameRowGap(label, cell, layout))
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

/**
 * 同一列的標籤離這一格夠不夠近：從標籤開頭量不超過 `sameRowMaxGap`，
 * 或從標籤**結尾**量不超過 `sameRowEndGap`（長標籤後面接的值，例如指派案號）。
 * `sameRowMaxGapByLabel` 有列的標籤（GCS 的 E／V／M）只認開頭量的那個距離，不套用其他兩條。
 *
 * @param {{str: string, col: number, width?: number}} label
 * @param {{col: number}} cell
 * @param {DiffConfig['layout']} layout
 * @returns {boolean}
 */
function isWithinSameRowGap(label, cell, layout) {
  const gapFromStart = cell.col - label.col;
  const ownGap = layout.sameRowMaxGapByLabel?.[labelKey(label.str)];
  if (ownGap != null) return gapFromStart <= ownGap;
  if (gapFromStart <= layout.sameRowMaxGap) return true;
  if (layout.sameRowEndGap == null) return false;
  const gapFromEnd = cell.col - (label.col + (label.width ?? 0));
  return gapFromEnd >= -(layout.sameRowEndOverlap ?? 0) && gapFromEnd <= layout.sameRowEndGap;
}

/**
 * 生命徵象表上印的時間點標籤（`現場`、`送醫途中`、`到院後`），帶上顯示名稱。
 * @param {ReturnType<typeof withFrame>} items
 * @param {VitalSignsConfig|undefined} vitalSigns
 * @returns {(ReturnType<typeof withFrame>[number] & {timepointName: string})[]}
 */
function findVitalTimepoints(items, vitalSigns) {
  if (!vitalSigns) return [];
  const nameByKey = new Map(vitalSigns.timepoints.map((timepoint) => [labelKey(timepoint.label), timepoint.name]));
  return items
    .filter((item) => nameByKey.has(labelKey(item.str)))
    .map((item) => ({ ...item, timepointName: nameByKey.get(labelKey(item.str)) }));
}

/**
 * 這一格是生命徵象表哪個時間點的（純函式）；不在表裡回傳 null。
 *
 * 時間點標籤印在每一格最下面：取「列不早於這格 `rowBelow`、不晚於 `rowAbove`」裡最上面那一個。
 *
 * @param {{row: number, col: number, page: number}} cell
 * @param {ReturnType<typeof findVitalTimepoints>} timepoints
 * @param {VitalSignsConfig|undefined} vitalSigns
 * @returns {string|null} 時間點的顯示名稱
 */
export function vitalTimepointOf(cell, timepoints, vitalSigns) {
  if (!vitalSigns) return null;
  const found = timepoints
    .filter((timepoint) => timepoint.page === cell.page
      && cell.col >= timepoint.col - vitalSigns.colLead
      && timepoint.row - cell.row >= -vitalSigns.rowBelow
      && timepoint.row - cell.row <= vitalSigns.rowAbove)
    .sort((upper, lower) => upper.row - lower.row)[0];
  return found ? found.timepointName : null;
}

/**
 * 欄位名稱加上生命徵象的時間點（`時間` → `生命徵象（到院後）量測時間`）。
 * 不是生命徵象的欄位、或找不到時間點，照原樣回傳。
 *
 * @param {string} label 表上的欄位名（已換成 labelNames）
 * @param {{row: number, col: number, page: number}} cell
 * @param {{timepoints: ReturnType<typeof findVitalTimepoints>, config: DiffConfig}} context
 * @returns {string}
 */
function qualifyVitalLabel(label, cell, context) {
  const vitalSigns = context.config.vitalSigns;
  if (!vitalSigns || !vitalSigns.columns.map(labelKey).includes(labelKey(label))) return label;
  const timepoint = vitalTimepointOf(cell, context.timepoints, vitalSigns);
  if (!timepoint) return label;
  return `${vitalSigns.title}（${timepoint}）${vitalSigns.columnNames?.[label] ?? label}`;
}

/**
 * 生命徵象表裡的勾選框（意識狀況的清／聲／痛／否）寫得出是哪個時間點的哪一欄；
 * 其他勾選框不猜區塊（實際版面同一列橫跨好幾個區塊，猜出來常常是錯的），回傳 null。
 * @returns {string|null}
 */
function vitalCheckboxField(cell, context) {
  if (!context.config.vitalSigns) return null;
  const attributed = attributeCell(cell, context.labels, context.config.layout);
  if (attributed.source !== 'inline' || !attributed.label) return null;
  const label = context.config.labelNames?.[attributed.label] ?? attributed.label;
  const qualified = qualifyVitalLabel(label, cell, context);
  return qualified === label ? null : qualified;
}

/**
 * 勾選框落在哪個區塊（`layout.checkboxGroups`，由上往下第一個符合的）；都不在回傳 null。
 * @param {{row: number, col: number}} cell
 * @param {DiffConfig['layout']} layout
 * @returns {string|null}
 */
export function checkboxGroupOf(cell, layout) {
  const group = (layout.checkboxGroups ?? []).find((area) => cell.row >= area.rowFrom && cell.row <= area.rowTo
    && cell.col >= area.colFrom && cell.col <= area.colTo);
  return group ? group.label : null;
}

/**
 * 一處勾選的改動寫成一處（一段裡好幾個框改了就好幾處）不同：區塊、選項、勾選還是取消勾選。
 *
 * 區塊**只認位置**（生命徵象表，或 `layout.checkboxGroups`）：不拿附近的標籤猜——實際版面同一列橫跨好幾個區塊，
 * 猜出來的常常是錯的（2026-11-03：「霧化吸入型面罩」被歸到「傷病患財物明細」）。
 * 選項文字取同一段記號後面的字（`■ 保暖`），單獨一個 `□` 就取右邊緊鄰的那一段——
 * 那一段在兩份裡要一模一樣才算 `optionVerified`（雲端另外還要在印好的選項白名單裡才寫出）。
 *
 * @param {{before: object|null, after: object|null}} diff
 * @param {{labels: object[], items: object[], beforeItems: object[], timepoints: object[], config: DiffConfig}} context
 * @returns {SheetChange[]}
 */
function describeCheckboxCell(diff, context) {
  const cell = diff.after ?? diff.before;
  const beforeText = diff.before?.str ?? '';
  const afterText = diff.after?.str ?? '';
  const group = vitalCheckboxField(cell, context) ?? checkboxGroupOf(cell, context.config.layout);
  const { layout } = context.config;
  return describeCheckboxEdits(beforeText, afterText).map((edit) => {
    let option = edit.option;
    let optionVerified = edit.optionStable;
    if (option === null && edit.action !== 'changed') {
      const nextAfter = diff.after ? optionNextTo(diff.after, context.items, layout) : null;
      const nextBefore = diff.before ? optionNextTo(diff.before, context.beforeItems, layout) : null;
      option = nextAfter ?? nextBefore;
      optionVerified = Boolean(diff.after && diff.before && nextAfter !== null && nextAfter === nextBefore);
    }
    return {
      kind: 'checkbox', before: [beforeText], after: [afterText], fields: group ? [group] : [],
      fieldSource: group ? 'inline' : 'unknown', segments: [], option, optionVerified,
      checkAction: edit.action, checkedBefore: edit.checkedBefore, checkedAfter: edit.checkedAfter,
    };
  });
}

/**
 * 勾選的動作寫成字：勾選／取消勾選／更動勾選。
 * @param {'checked'|'unchecked'|'changed'|undefined} action
 * @returns {string}
 */
export function checkActionText(action) {
  if (action === 'checked') return '勾選';
  if (action === 'unchecked') return '取消勾選';
  return '更動勾選';
}

/**
 * 單獨一個勾選框旁邊的選項文字（同一列、後面最近的一段）。
 * @param {{row: number, col: number, page: number}} cell
 * @param {ReturnType<typeof withFrame>} items 同一份紀錄表的所有文字
 * @param {DiffConfig['layout']} layout
 * @returns {string|null}
 */
function optionNextTo(cell, items, layout) {
  const next = items
    .filter((item) => item.page === cell.page && !isLoneCheckbox(item.str)
      && Math.abs(item.row - cell.row) <= layout.rowTolerance
      && item.col > cell.col && item.col - cell.col <= layout.optionMaxGap)
    .sort((left, right) => left.col - right.col)[0];
  return next ? cleanOption(next.str) || null : null;
}

/**
 * 一段改動（配對成功但文字不同、或只出現在一邊）寫成一處不同。
 *
 * @param {{before: object|null, after: object|null}} diff
 * @param {{labels: object[], items: object[], beforeItems: object[], timepoints: object[], config: DiffConfig}} context
 * @returns {SheetChange[]} 填值一處；勾選框一段裡好幾個框改了就好幾處
 */
function describeCell(diff, context) {
  const cell = diff.after ?? diff.before;
  const beforeText = diff.before?.str ?? '';
  const afterText = diff.after?.str ?? '';
  const isCheckbox = CHECKBOX_MARKS.test(beforeText) || CHECKBOX_MARKS.test(afterText);
  if (isCheckbox) return describeCheckboxCell(diff, context);
  const attributed = attributeCell(cell, context.labels, context.config.layout);
  const source = attributed.source;
  const baseLabel = attributed.label ? context.config.labelNames?.[attributed.label] ?? attributed.label : null;
  const label = baseLabel && source === 'inline' ? qualifyVitalLabel(baseLabel, cell, context) : baseLabel;
  const fields = label ? [label] : [];
  const segments = label && source === 'inline'
    ? [{ label, baseLabel, before: beforeText.trim(), after: afterText.trim() }]
    : [];
  return [{ kind: 'value', before: [beforeText], after: [afterText], fields, fieldSource: source, segments, option: null }];
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
  const template = after.length > 0 ? after : before;
  const labels = findLayoutLabels(template, config.layoutLabels);
  const timepoints = findVitalTimepoints(template, config.vitalSigns);
  const context = { labels, items: after, beforeItems: before, timepoints, config };
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
  return mergeByField(diffs.flatMap((diff) => describeCell(diff, context)));
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
    // 白名單與個資判斷看表上印的欄位名（`時間`），不看加了時間點的顯示名稱。
    const baseLabel = segment.baseLabel ?? segment.label;
    const showable = config.cloudValueLabels.map(labelKey).includes(labelKey(baseLabel))
      && !isSensitiveLabel(baseLabel, config.sensitiveLabels);
    if (!showable) return `更正「${segment.label}」`;
    const before = toCloudValue(segment.before, config.cloudMaxValueLength);
    const after = toCloudValue(segment.after, config.cloudMaxValueLength);
    if (before === null || after === null) return `更正「${segment.label}」`;
    return `「${segment.label}」${before} → ${after}`;
  }).join('、');
}

/**
 * 已知區塊裡的一處勾選寫成雲端的一句話：「「非創傷」勾選「腹痛」」。
 *
 * 以下只寫「「區塊」勾選有更動」、不寫選項：
 * - 選項不在 `checkboxPrintedOptions`（表上印好的選項白名單）——勾選框旁邊的手寫內容就算兩份一樣也擋得住
 * - 選項沒有在兩份裡一模一樣（`optionVerified`，第二道檢查）——變的是文字本身
 * - `sensitiveCheckboxGroups` 列的區塊（明確列名、完全相等；**目前空的**，使用者 2026-11-07 確認所有區塊的選項都可以顯示）。
 *   不用 `sensitiveLabels` 的「包含」比對（「無法簽名原因」含「簽名」，但不是個資）
 * 寫出的選項套用 `checkboxOptionNames` 的顯示名稱（PDF 斷行切出的半句）。
 * - 選項太長或認不出
 * 5 碼以上的數字一律遮掉（最後一道防線）。
 *
 * @param {SheetChange} change
 * @param {DiffConfig} config
 * @returns {string}
 */
function describeCheckboxForCloud(change, config) {
  const group = change.fields[0];
  const showable = Boolean(change.option) && change.optionVerified
    && (config.checkboxPrintedOptions ?? []).includes(change.option)
    && !(config.sensitiveCheckboxGroups ?? []).includes(group)
    && change.option.length <= config.cloudMaxValueLength;
  const shown = showable ? config.checkboxOptionNames?.[change.option] ?? change.option : null;
  const option = shown ? shown.replace(/\d{5,}/g, '#####') : null;
  if (!option) return `「${group}」勾選有更動`;
  return `「${group}」${checkActionText(change.checkAction)}「${option}」`;
}

/**
 * 雲端版的差異摘要（網頁工單上顯示用，**不含病患資料**）。
 *
 * - 填值：同一欄只寫一次
 * - 勾選框（v1.57.3，使用者 2026-11-07 指定要寫出改了哪個勾選）：落在已知區塊（生命徵象表、`layout.checkboxGroups`）的，
 *   寫「「傷病患類別」取消勾選「創傷」」；區塊外的不寫選項（旁邊可能是手寫內容），合成一句「有 N 個勾選項目有更動」
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
    if (change.kind === 'checkbox' && change.fields.length > 0) items.push(describeCheckboxForCloud(change, config));
    else if (change.kind === 'checkbox') checkboxes += 1;
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
      const block = change.fields.length > 0 ? change.fields.join('、') : '勾選框';
      const what = change.option ? `${checkActionText(change.checkAction)}「${change.option}」` : `${checkActionText(change.checkAction)}（認不出是哪一項）`;
      lines.push(`${position + 1}. 〔${block}〕${what}`);
    } else {
      lines.push(`${position + 1}. 〔${where}〕`);
    }
    lines.push(`   解鎖前：${show(change.before)}`);
    lines.push(`   結案後：${show(change.after)}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
