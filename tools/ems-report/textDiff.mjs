/**
 * 一格文字改前改後的**逐字差異**（純函式，無副作用，可單獨測試）。
 *
 * 用途（小工具 v1.59.0，使用者 2026-11-22 要求）：補述欄、主訴、地址這類文字只改了一兩處時，
 * 本機報告除了整段原文與整段新文，再列出「改了哪裡」，不必自己逐字對照：
 *   ‧ 在「車禍後」後面：「左」改成「右」
 *   ‧ 在「送醫途中」後面：刪掉「血壓下降」
 *
 * ⚠ 結果**含病患資料**，只給本機報告（差異說明、解鎖修改紀錄）用，**絕不上雲**（雲端版見 `sheetDiff.mjs` 的 `toCloudItems`）。
 *
 * 作法：
 *   1. 空白一律壓成一個半形空白（PDF 切段不同，兩份的空白位置常常不一樣）
 *   2. 去掉頭尾相同的部分，中間用最長共同子序列（LCS）逐字比
 *   3. 夾在兩處改動中間、太短（不到 `minEqualRun` 字）或只有空白的相同片段併進改動——
 *      不然一整句重寫時，會被常見的字（的、病、患）切成一堆碎片
 *   4. 只差空白的改動不算
 *   5. 改動的邊界落在數字或英文字中間時，併進整個數字／英文字（`10` → `15`，不寫成 `0` → `5`）
 *   6. 沒改動的字太少（`minUnchangedChars`、`minUnchangedRatio`）就說「整段改寫」，不硬拆
 */

/**
 * @typedef {Object} TextDiffConfig 逐字差異的設定（對應 `UNLOCK.revision.textDiff`）
 * @property {number} minTextLength 兩邊都不超過這個字數就不另外說明（短到一眼看得出）
 * @property {number} minEqualRun 夾在兩處改動中間的相同片段，少於幾個字就併進改動
 * @property {number} minUnchangedChars 沒改動的字少於幾個就算整段改寫
 * @property {number} minUnchangedRatio 沒改動的字佔較長那一份的比例低於多少就算整段改寫（0～1）
 * @property {number} contextChars 每處改動帶幾個前後沒變的字，方便在長文裡找到位置
 * @property {number} maxEdits 最多列幾處（其餘寫「另有 N 處」）
 * @property {number} maxEditChars 一處改動一邊最多印幾個字
 * @property {number} maxCells 逐字比對最多比幾格（去掉頭尾相同部分後，兩邊字數相乘；超過就不比，免得整頁擠成一行時算太久）
 */

/**
 * @typedef {Object} TextEdit 一處逐字改動
 * @property {string} removed 刪掉的字（空字串＝只有加上）
 * @property {string} added 加上的字（空字串＝只有刪掉）
 * @property {string} contextBefore 改動前面沒變的幾個字（空字串＝在開頭）
 * @property {string} contextAfter 改動後面沒變的幾個字（空字串＝在結尾）
 */

/**
 * @typedef {{kind: 'none'} | {kind: 'rewritten'} | {kind: 'tooLong'} | {kind: 'edits', edits: TextEdit[]}} TextDiffResult
 *   - `none`：不必另外說明（有一邊是空的、只差空白、或兩邊都短到一眼看得出）
 *   - `rewritten`：整段改寫（沒改動的字太少，硬拆只會是一堆碎片）
 *   - `tooLong`：太長，沒有逐字比
 *   - `edits`：逐處列出
 */

/** @typedef {{type: 'equal'|'delete'|'insert', text: string}} DiffOp 逐字比對的一個片段 */

/** @typedef {{type: 'equal', text: string} | {type: 'change', removed: string, added: string}} DiffBlock */

/** 空白壓成一個半形空白、去掉頭尾空白。 */
function normalizeSpaces(text) {
  return String(text ?? '').replace(/[\s　]+/g, ' ').trim();
}

/** 不算空白有幾個字（以字元計，罕用字的代理對算一個）。 */
function countVisibleChars(text) {
  return Array.from(text.replace(/\s+/g, '')).length;
}

/** 頭尾相同的長度（尾巴不跟頭重疊）。 */
function commonEnds(before, after) {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { prefix, suffix };
}

/** 加一個片段：跟前一個同類就接起來，空的不加。 */
function pushOp(ops, type, text) {
  if (!text) return;
  const last = ops.at(-1);
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

/**
 * 逐字比對（最長共同子序列），回傳依序的片段。
 *
 * @param {string[]} before 已拆成單字
 * @param {string[]} after
 * @returns {DiffOp[]}
 */
function lcsOps(before, after) {
  const cols = after.length + 1;
  // table[i*cols+j]＝before[i..] 與 after[j..] 的最長共同子序列長度；呼叫端限制過格數，長度不超過 65535。
  const table = new Uint16Array((before.length + 1) * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = before[i] === after[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pushOp(ops, 'equal', before[i]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      pushOp(ops, 'delete', before[i]);
      i += 1;
    } else {
      pushOp(ops, 'insert', after[j]);
      j += 1;
    }
  }
  pushOp(ops, 'delete', before.slice(i).join(''));
  pushOp(ops, 'insert', after.slice(j).join(''));
  return ops;
}

/**
 * 片段 → 「沒變／改動」交錯的區塊。
 *
 * 夾在兩處改動中間的相同片段，太短（不到 `minEqualRun` 個字，空白不算）就併進改動；
 * 併完之後只差空白的改動當成沒變。
 *
 * @param {DiffOp[]} ops 相鄰的片段不同類（`pushOp` 保證）
 * @param {number} minEqualRun
 * @returns {DiffBlock[]}
 */
function toBlocks(ops, minEqualRun) {
  /** @type {DiffBlock[]} */
  const blocks = [];
  for (const [index, op] of ops.entries()) {
    const between = index > 0 && index < ops.length - 1;
    const absorbed = op.type === 'equal' && between && countVisibleChars(op.text) < minEqualRun;
    if (op.type === 'equal' && !absorbed) {
      blocks.push({ type: 'equal', text: op.text });
      continue;
    }
    let block = blocks.at(-1);
    if (!block || block.type !== 'change') {
      block = { type: 'change', removed: '', added: '' };
      blocks.push(block);
    }
    if (op.type !== 'insert') block.removed += op.text;
    if (op.type !== 'delete') block.added += op.text;
  }
  return mergeWhitespaceOnlyChanges(blocks);
}

/** 數字與英文字（改動的邊界不切開它們）。 */
const WORD_CHAR = /[0-9A-Za-z０-９]/;

/** 這段文字結尾連續幾個數字／英文字。 */
function trailingWordRun(text) {
  const chars = Array.from(text);
  let start = chars.length;
  while (start > 0 && WORD_CHAR.test(chars[start - 1])) start -= 1;
  return chars.slice(start).join('');
}

/** 這段文字開頭連續幾個數字／英文字。 */
function leadingWordRun(text) {
  const chars = Array.from(text);
  let end = 0;
  while (end < chars.length && WORD_CHAR.test(chars[end])) end += 1;
  return chars.slice(0, end).join('');
}

/**
 * 改動的邊界落在數字或英文字中間時，把整個數字／英文字併進改動：
 * `10L/min` → `15L/min` 寫成「「10」改成「15」」，不是「在「面罩1」後面：「0」改成「5」」。
 *
 * @param {DiffBlock[]} blocks
 * @returns {DiffBlock[]}
 */
function expandToWholeWords(original) {
  const blocks = original.map((block) => ({ ...block }));
  const startsWithWord = (block) => [block.removed, block.added].some((text) => WORD_CHAR.test(Array.from(text)[0] ?? ''));
  const endsWithWord = (block) => [block.removed, block.added].some((text) => WORD_CHAR.test(Array.from(text).at(-1) ?? ''));
  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'change') continue;
    const previous = blocks[index - 1];
    if (previous?.type === 'equal' && startsWithWord(block)) {
      const run = trailingWordRun(previous.text);
      previous.text = previous.text.slice(0, previous.text.length - run.length);
      block.removed = run + block.removed;
      block.added = run + block.added;
    }
    const next = blocks[index + 1];
    if (next?.type === 'equal' && endsWithWord(block)) {
      const run = leadingWordRun(next.text);
      next.text = next.text.slice(run.length);
      block.removed += run;
      block.added += run;
    }
  }
  /** @type {DiffBlock[]} */
  const merged = [];
  for (const block of blocks) {
    if (block.type === 'equal' && !block.text) continue;
    const last = merged.at(-1);
    if (block.type === 'change' && last?.type === 'change') {
      last.removed += block.removed;
      last.added += block.added;
    } else merged.push(block);
  }
  return merged;
}

/** 只差空白的改動當成沒變，跟前後沒變的區塊接起來。 */
function mergeWhitespaceOnlyChanges(blocks) {
  /** @type {DiffBlock[]} */
  const merged = [];
  for (const block of blocks) {
    const asEqual = block.type === 'change' && !block.removed.trim() && !block.added.trim()
      ? { type: 'equal', text: block.removed }
      : block;
    const last = merged.at(-1);
    if (asEqual.type === 'equal' && last && last.type === 'equal') last.text += asEqual.text;
    else merged.push(asEqual);
  }
  return merged;
}

/**
 * 每處改動帶上前後沒變的幾個字。
 * @param {DiffBlock[]} blocks
 * @param {number} contextChars
 * @returns {TextEdit[]}
 */
function toEdits(blocks, contextChars) {
  const tail = (block) => (block?.type === 'equal' ? Array.from(block.text.trimEnd()).slice(-contextChars).join('').trim() : '');
  const head = (block) => (block?.type === 'equal' ? Array.from(block.text.trimStart()).slice(0, contextChars).join('').trim() : '');
  return blocks.flatMap((block, index) => (block.type !== 'change' ? [] : [{
    removed: normalizeSpaces(block.removed),
    added: normalizeSpaces(block.added),
    contextBefore: tail(blocks[index - 1]),
    contextAfter: head(blocks[index + 1]),
  }]));
}

/**
 * 比對一格文字的改前改後，找出改了哪裡（純函式）。
 *
 * @param {string} beforeText 解鎖前（原內容）
 * @param {string} afterText 結案後（修改後內容）
 * @param {TextDiffConfig} config
 * @returns {TextDiffResult}
 */
export function diffText(beforeText, afterText, config) {
  const before = normalizeSpaces(beforeText);
  const after = normalizeSpaces(afterText);
  if (!before || !after || before === after) return { kind: 'none' };
  const beforeChars = Array.from(before);
  const afterChars = Array.from(after);
  if (Math.max(beforeChars.length, afterChars.length) <= config.minTextLength) return { kind: 'none' };
  const { prefix, suffix } = commonEnds(beforeChars, afterChars);
  const middleBefore = beforeChars.slice(prefix, beforeChars.length - suffix);
  const middleAfter = afterChars.slice(prefix, afterChars.length - suffix);
  if (middleBefore.length * middleAfter.length > config.maxCells) return { kind: 'tooLong' };
  const ops = [];
  pushOp(ops, 'equal', beforeChars.slice(0, prefix).join(''));
  for (const op of lcsOps(middleBefore, middleAfter)) pushOp(ops, op.type, op.text);
  pushOp(ops, 'equal', beforeChars.slice(beforeChars.length - suffix).join(''));
  const blocks = toBlocks(ops, config.minEqualRun);
  const unchanged = blocks.reduce((sum, block) => sum + (block.type === 'equal' ? countVisibleChars(block.text) : 0), 0);
  const longer = Math.max(countVisibleChars(before), countVisibleChars(after));
  if (unchanged < config.minUnchangedChars || unchanged / longer < config.minUnchangedRatio) return { kind: 'rewritten' };
  // 沒變的字數用併整個數字之前的算：身分證只改一碼，併完整串都算改動，但其實九成沒變
  const edits = toEdits(expandToWholeWords(blocks), config.contextChars);
  // 改動涵蓋整格（前後都沒有沒變的字）時，改前改後兩段就說完了，不另外說明
  const coversWhole = edits.length === 1 && !edits[0].contextBefore && !edits[0].contextAfter;
  return edits.length > 0 && !coversWhole ? { kind: 'edits', edits } : { kind: 'none' };
}

/** 一邊太長就截斷（以字元計）。 */
function clipChars(text, maxChars) {
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

/**
 * 一處改動寫成一句話：`在「車禍後」後面：「左」改成「右」`。
 * 前面沒有沒變的字（改在開頭）時改用後面的字定位：`在「手擦傷」前面：加上「疑似」`。
 *
 * @param {TextEdit} edit
 * @param {number} maxChars
 * @returns {string}
 */
function describeEdit(edit, maxChars) {
  const removed = clipChars(edit.removed, maxChars);
  const added = clipChars(edit.added, maxChars);
  let what = `加上「${added}」`;
  if (removed && added) what = `「${removed}」改成「${added}」`;
  else if (removed) what = `刪掉「${removed}」`;
  if (edit.contextBefore) return `在「${edit.contextBefore}」後面：${what}`;
  if (edit.contextAfter) return `在「${edit.contextAfter}」前面：${what}`;
  return what;
}

/**
 * 逐字差異寫成給人看的句子（純函式）。
 *
 * @param {TextDiffResult} result
 * @param {TextDiffConfig} config
 * @returns {string[]} 一處一句；整段改寫、太長各一句；不必說明時是空陣列
 */
export function describeTextDiff(result, config) {
  if (result.kind === 'rewritten') return ['整段改寫，請直接對照前後兩段內容'];
  if (result.kind === 'tooLong') return ['內容太長，沒有逐字比對，請直接對照前後兩段內容'];
  if (result.kind !== 'edits') return [];
  const lines = result.edits.slice(0, config.maxEdits).map((edit) => describeEdit(edit, config.maxEditChars));
  const rest = result.edits.length - config.maxEdits;
  if (rest > 0) lines.push(`另有 ${rest} 處改動，請直接對照前後兩段內容`);
  return lines;
}
