/**
 * 兩份救護紀錄表的差異比對（**純函式**，無副作用，可單獨測試）。
 *
 * 用途（v1.54.0，使用者 2026-11-03 指定）：解鎖前備份的那份 vs 結案後的那份，
 * 條列出「哪裡不同」。
 *
 * 作法：
 *   1. 兩份 PDF 文字各自切成行，去掉每次產生都會變的行（列印時間、頁碼）
 *   2. 逐行比對（最長共同子序列），連在一起的增刪合成「一處不同」
 *   3. 每一處判斷是哪個欄位：
 *      - 改動的那幾行裡**就有標籤**（`姓名 王小明`）→ 依標籤切段，只算值真的變了的那幾欄
 *      - 改動的只有值（PDF 常是標籤一行、值一行）→ 往上找最近的標籤行，**只能說「附近」**
 *      - 都找不到 → 「未能判斷欄位」
 *
 * 產出兩種版本：
 *   - **本機版**：完整的改前改後內容（含病患資料，只寫進 `out/internal/`）
 *   - **雲端版**：只有欄位名稱；只有白名單欄位（時間、檢傷、生命徵象）、標籤與值在同一行、
 *     而且值看起來只是數字或分級時才寫出內容。其餘一律「更正「姓名」」這種寫法
 *     （使用者 2026-11-03：機密資料不要直接顯露，只寫更正了哪一欄）。
 *
 * ⚠ 沒有實際救護紀錄表 PDF 的文字樣本（個資不落檔），欄位判斷是依常見版面寫的，
 *   認不出來時寧可寫「未能判斷欄位」，也不硬猜。
 */

/**
 * @typedef {Object} SheetChange 一處不同
 * @property {string[]} before 解鎖前的那幾行（已整理空白，未遮蔽）
 * @property {string[]} after 結案後的那幾行
 * @property {string[]} fields 判斷出的欄位（依出現順序，可能為空）
 * @property {'inline'|'nearby'|'unknown'} fieldSource
 *   `inline`＝標籤就在改動的那幾行裡；`nearby`＝往上找到的最近標籤（只能說在附近）
 * @property {{label: string, before: string, after: string}[]} segments
 *   `inline` 時各欄位改前改後的值（只列真的變了的欄位）
 */

/**
 * @typedef {Object} DiffConfig 比對設定（對應 `UNLOCK.revision`）
 * @property {string[]} ignoreLinePatterns 要忽略的行（正規表示式字串）
 * @property {string[]} fieldLabels 認得出的欄位標籤
 * @property {string[]} sensitiveLabels 個資欄位（雲端只寫欄位名）
 * @property {string[]} cloudValueLabels 雲端可以寫出內容的欄位
 * @property {number} cloudMaxItems 雲端最多幾項
 * @property {number} cloudMaxValueLength 雲端內容一邊最多幾個字
 * @property {number} [labelLookbackLines] 往上找標籤最多找幾行（預設 3）
 */

/** 逐行比對的格子數上限：超過就不做細比對，整段當成一處不同（避免吃光記憶體）。 */
const MAX_DIFF_CELLS = 4_000_000;

/** 比對用的鍵：壓掉所有空白、轉大寫。PDF 每次抽出來的空白數量不一定一樣，不算改動。 */
function compactKey(text) {
  return String(text ?? '').replace(/[\s　]+/g, '').toUpperCase();
}

/**
 * 把紀錄表全文切成要比對的行。
 *
 * @param {string} text PDF 抽出來的文字
 * @param {string[]} [ignorePatterns] 要忽略的行（正規表示式字串，比對整理過空白的行）
 * @returns {string[]} 已整理空白、去掉空行與忽略行
 */
export function toSheetLines(text, ignorePatterns = []) {
  const ignores = ignorePatterns.map((pattern) => new RegExp(pattern, 'i'));
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[\s　]+/g, ' ').trim())
    .filter((line) => line !== '' && !ignores.some((pattern) => pattern.test(line)));
}

/**
 * 逐行比對（最長共同子序列）。
 *
 * 先剪掉頭尾相同的行再做表：紀錄表改動通常只有幾處，頭尾剪掉之後表格小得多。
 *
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {{type: 'same'|'removed'|'added', line: string, oldIndex: number, newIndex: number}[]}
 *   `oldIndex`／`newIndex` 是這一行（或插入點）在各自那一份的位置
 */
export function diffLines(oldLines, newLines) {
  const oldKeys = oldLines.map(compactKey);
  const newKeys = newLines.map(compactKey);
  let head = 0;
  while (head < oldKeys.length && head < newKeys.length && oldKeys[head] === newKeys[head]) head += 1;
  let tail = 0;
  while (
    tail < oldKeys.length - head && tail < newKeys.length - head
    && oldKeys[oldKeys.length - 1 - tail] === newKeys[newKeys.length - 1 - tail]
  ) tail += 1;

  const ops = [];
  for (let index = 0; index < head; index += 1) {
    ops.push({ type: 'same', line: newLines[index], oldIndex: index, newIndex: index });
  }
  const oldMiddle = oldKeys.slice(head, oldKeys.length - tail);
  const newMiddle = newKeys.slice(head, newKeys.length - tail);
  ops.push(...diffMiddle(oldLines, newLines, oldMiddle, newMiddle, head));
  for (let offset = tail; offset > 0; offset -= 1) {
    ops.push({
      type: 'same',
      line: newLines[newLines.length - offset],
      oldIndex: oldLines.length - offset,
      newIndex: newLines.length - offset,
    });
  }
  return ops;
}

/** 中間那一段的最長共同子序列比對。`base` 是剪掉的頭有幾行。 */
function diffMiddle(oldLines, newLines, oldKeys, newKeys, base) {
  const rows = oldKeys.length;
  const cols = newKeys.length;
  const removedAll = () => oldKeys.map((_key, index) => ({
    type: 'removed', line: oldLines[base + index], oldIndex: base + index, newIndex: base,
  }));
  const addedAll = (oldIndex) => newKeys.map((_key, index) => ({
    type: 'added', line: newLines[base + index], oldIndex, newIndex: base + index,
  }));
  if (rows === 0 || cols === 0 || (rows + 1) * (cols + 1) > MAX_DIFF_CELLS) {
    return [...removedAll(), ...addedAll(base + rows)];
  }

  // table[i][j]＝oldKeys[i..] 與 newKeys[j..] 的最長共同子序列長度（攤平成一維陣列）。
  const width = cols + 1;
  const table = new Int32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldKeys[i] === newKeys[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldKeys[i] === newKeys[j]) {
      ops.push({ type: 'same', line: newLines[base + j], oldIndex: base + i, newIndex: base + j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: 'removed', line: oldLines[base + i], oldIndex: base + i, newIndex: base + j });
      i += 1;
    } else {
      ops.push({ type: 'added', line: newLines[base + j], oldIndex: base + i, newIndex: base + j });
      j += 1;
    }
  }
  for (; i < rows; i += 1) {
    ops.push({ type: 'removed', line: oldLines[base + i], oldIndex: base + i, newIndex: base + cols });
  }
  for (; j < cols; j += 1) {
    ops.push({ type: 'added', line: newLines[base + j], oldIndex: base + rows, newIndex: base + j });
  }
  return ops;
}

/**
 * 把連在一起的增刪合成「一處不同」。
 *
 * @param {ReturnType<typeof diffLines>} ops
 * @returns {{before: string[], after: string[], oldStart: number}[]}
 *   `oldStart`＝這一處在解鎖前那一份從第幾行開始（往上找標籤用）
 */
export function groupChanges(ops) {
  const hunks = [];
  let current = null;
  for (const op of ops) {
    if (op.type === 'same') {
      current = null;
      continue;
    }
    if (!current) {
      current = { before: [], after: [], oldStart: op.oldIndex };
      hunks.push(current);
    }
    if (op.type === 'removed') current.before.push(op.line);
    else current.after.push(op.line);
  }
  return hunks;
}

/**
 * 找出一行文字裡出現了哪些標籤（依出現位置排序，長的優先、不重疊）。
 *
 * 「長的優先」是為了 `到院前檢傷分級` 不要被拆成 `檢傷分級`、`身分證字號` 不要只認成 `身分證`。
 *
 * @param {string} text
 * @param {string[]} labels
 * @returns {{label: string, start: number, end: number}[]} 位置是**壓掉空白後**的索引
 */
export function findLabels(text, labels) {
  const compacted = compactKey(text);
  const sorted = [...new Set(labels)].filter(Boolean).sort((left, right) => right.length - left.length);
  /** @type {{label: string, start: number, end: number}[]} */
  const found = [];
  for (const label of sorted) {
    const key = compactKey(label);
    let from = 0;
    for (;;) {
      const start = compacted.indexOf(key, from);
      if (start === -1) break;
      const end = start + key.length;
      from = end;
      if (found.some((item) => start < item.end && end > item.start)) continue;
      found.push({ label, start, end });
    }
  }
  return found.sort((left, right) => left.start - right.start);
}

/**
 * 依標籤把一段文字切成「標籤 → 值」。
 *
 * 值＝標籤後面到下一個標籤之前的文字（壓掉空白）。第一個標籤之前的文字放在 `prefix`。
 *
 * @param {string} text
 * @param {string[]} labels
 * @returns {{prefix: string, values: Map<string, string>}}
 *   同一標籤出現多次時，值以「｜」串起來
 */
export function splitByLabels(text, labels) {
  const compacted = compactKey(text);
  const hits = findLabels(text, labels);
  const values = new Map();
  const prefix = hits.length === 0 ? compacted : compacted.slice(0, hits[0].start);
  hits.forEach((hit, position) => {
    const next = hits[position + 1];
    const value = compacted.slice(hit.end, next ? next.start : compacted.length);
    values.set(hit.label, values.has(hit.label) ? `${values.get(hit.label)}｜${value}` : value);
  });
  return { prefix, values };
}

/**
 * 往上找最近的標籤行：值跟標籤分在不同行時，只能靠這個說出「大概是哪一欄」。
 *
 * @param {string[]} oldLines 解鎖前那一份的行
 * @param {number} fromIndex 從這一行的上一行開始往上找
 * @param {string[]} labels
 * @param {number} lookback 最多找幾行
 * @returns {string[]} 那一行的所有標籤；找不到為空陣列
 */
function findNearbyLabels(oldLines, fromIndex, labels, lookback) {
  for (let index = fromIndex - 1; index >= 0 && index >= fromIndex - lookback; index -= 1) {
    const hits = findLabels(oldLines[index], labels);
    if (hits.length > 0) return [...new Set(hits.map((hit) => hit.label))];
  }
  return [];
}

/**
 * 判斷一處不同是哪幾個欄位。
 *
 * @param {{before: string[], after: string[], oldStart: number}} hunk
 * @param {string[]} oldLines
 * @param {DiffConfig} config
 * @returns {SheetChange}
 */
function describeHunk(hunk, oldLines, config) {
  const before = splitByLabels(hunk.before.join('\n'), config.fieldLabels);
  const after = splitByLabels(hunk.after.join('\n'), config.fieldLabels);
  const labelOrder = [...new Set([...before.values.keys(), ...after.values.keys()])];
  const segments = labelOrder
    .map((label) => ({
      label,
      before: before.values.get(label) ?? '',
      after: after.values.get(label) ?? '',
    }))
    .filter((segment) => segment.before !== segment.after);

  const base = { before: hunk.before, after: hunk.after };
  // 改動的行裡有標籤、而且切得出「哪幾欄的值變了」：最精確的情形。
  // 標籤之前那一段（prefix）也變了的話，那一段屬於上面某一欄，一併往上找。
  if (segments.length > 0 && before.prefix === after.prefix) {
    return { ...base, fields: segments.map((segment) => segment.label), fieldSource: 'inline', segments };
  }
  const nearby = findNearbyLabels(
    oldLines,
    hunk.oldStart,
    config.fieldLabels,
    config.labelLookbackLines ?? 3,
  );
  const fields = [...new Set([...segments.map((segment) => segment.label), ...nearby])];
  if (fields.length === 0) return { ...base, fields: [], fieldSource: 'unknown', segments: [] };
  return { ...base, fields, fieldSource: segments.length > 0 ? 'inline' : 'nearby', segments };
}

/**
 * 比對兩份紀錄表，列出每一處不同。
 *
 * @param {string} beforeText 解鎖前（備份）的全文
 * @param {string} afterText 結案後的全文
 * @param {DiffConfig} config
 * @returns {SheetChange[]} 沒有不同時為空陣列
 */
export function describeChanges(beforeText, afterText, config) {
  const oldLines = toSheetLines(beforeText, config.ignoreLinePatterns);
  const newLines = toSheetLines(afterText, config.ignoreLinePatterns);
  return groupChanges(diffLines(oldLines, newLines)).map((hunk) => describeHunk(hunk, oldLines, config));
}

/** 這個欄位是不是個資欄位（包含比對：`身分證` 也認得 `身分證字號`）。 */
function isSensitiveLabel(label, sensitiveLabels) {
  const key = compactKey(label);
  return sensitiveLabels.some((sensitive) => key.includes(compactKey(sensitive)));
}

/**
 * 雲端可以寫出來的值：只有數字、時間、血壓、分級這類寫法。
 *
 * 這是最後一道防線：就算欄位切錯了、把姓名切進「到院時間」那一段，
 * 姓名也過不了這個樣式，只會退回「只寫欄位名」。
 */
const CLOUD_SAFE_VALUE = /^[0-9０-９:：/／\-.．,，%％°℃()（）~～\sA-Za-z第一二三四五六級]*$/;

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
 * 把一處不同寫成雲端可以顯示的一句話（不含病患資料）。
 *
 * @param {SheetChange} change
 * @param {DiffConfig} config
 * @returns {string}
 */
function describeForCloud(change, config) {
  const names = change.fields.map((field) => `「${field}」`).join('');
  if (change.fieldSource === 'nearby') return `${names}附近的內容有更動`;

  // 同一處只要碰到任何個資欄位，就整處只寫欄位名：值切錯段的話，寫出來的可能正是個資。
  const touchesSensitive = change.fields.some((field) => isSensitiveLabel(field, config.sensitiveLabels));
  const parts = change.segments.map((segment) => {
    const showable = !touchesSensitive
      && config.cloudValueLabels.includes(segment.label)
      && !isSensitiveLabel(segment.label, config.sensitiveLabels);
    if (!showable) return `更正「${segment.label}」`;
    const before = toCloudValue(segment.before, config.cloudMaxValueLength);
    const after = toCloudValue(segment.after, config.cloudMaxValueLength);
    if (before === null || after === null) return `更正「${segment.label}」`;
    return `「${segment.label}」${before} → ${after}`;
  });
  return parts.join('、');
}

/**
 * 雲端版的差異摘要（網頁工單上顯示用，**不含病患資料**）。
 *
 * @param {SheetChange[]} changes
 * @param {DiffConfig} config
 * @returns {{items: string[], changeCount: number}}
 */
export function toCloudItems(changes, config) {
  // 同一欄改了好幾處只寫一次；判斷不出欄位的合成一句「有 N 處」，不必每處各寫一行一樣的話。
  const known = changes.filter((change) => change.fieldSource !== 'unknown');
  const unknownCount = changes.length - known.length;
  const items = [...new Set(known.map((change) => describeForCloud(change, config)))];
  if (unknownCount > 0) items.push(`有 ${unknownCount} 處內容不同（未能判斷是哪一欄，詳見本機報告）`);
  if (items.length <= config.cloudMaxItems) return { items, changeCount: changes.length };
  const shown = items.slice(0, config.cloudMaxItems - 1);
  return {
    items: [...shown, `另有 ${items.length - shown.length} 項不同（詳見本機報告）`],
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
    lines.push('兩份內容相同：解鎖之後沒有改動任何內容（列印時間、頁碼不列入比對）。');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`共 ${changes.length} 處不同：`, '');
  for (const [position, change] of changes.entries()) {
    const where = change.fieldSource === 'unknown'
      ? '未能判斷欄位'
      : `${change.fields.join('、')}${change.fieldSource === 'nearby' ? '（附近）' : ''}`;
    lines.push(`${position + 1}. 〔${where}〕`);
    if (change.segments.length > 0 && change.fieldSource === 'inline') {
      for (const segment of change.segments) {
        lines.push(`   ${segment.label}：「${segment.before || '（空白）'}」→「${segment.after || '（空白）'}」`);
      }
    }
    lines.push(`   解鎖前：${change.before.length > 0 ? change.before.map(clip).join(' ／ ') : '（無）'}`);
    lines.push(`   結案後：${change.after.length > 0 ? change.after.map(clip).join(' ／ ') : '（無）'}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
