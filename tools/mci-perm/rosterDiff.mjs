/**
 * 兩份名單比對：找出「全部名單有、保留名單沒有」的人。
 *
 * 使用者 2026-10-17 的用法：保留名單是從圖片抄下來的（只有單位與姓名），
 * 全部名單是 Excel。不在保留名單上的人，要去一站通取消 DQC DA-CPR 品管權限。
 *
 * 比對以**姓名**為主、單位為輔，而且一律往「不取消」那邊倒——
 * 取消錯人比漏取消嚴重（被取消的人當天就不能用系統，漏掉的下次再補就好）：
 *   - 保留名單完全沒有同名的人 → 取消
 *   - 有同名、單位也對得上（相同或互相包含）→ 保留
 *   - 有同名、單位對不上 → **存疑，不動**（兩份的單位寫法不同是常態，不能因此取消）
 *   - 保留名單沒對到任何人、但跟全部名單某位只差一個字 → **疑似抄錯字，不動**
 *     （圖片抄成文字難免看錯字，那一位如果照取消，就是取消到該保留的人）
 *
 * 純函式，不寫檔、不輸出 log（姓名屬個資，顯示由呼叫端遮蔽後處理）。
 */

/**
 * @typedef {import('./roster.mjs').RosterEntry} RosterEntry
 */

/**
 * @typedef {Object} UnitConflict 保留名單有同名、但單位對不上的人
 * @property {RosterEntry} entry 全部名單裡的那一位
 * @property {string[]} keepUnits 保留名單裡同名者寫的單位
 */

/**
 * @typedef {Object} TypoSuspect 疑似抄錯字：姓名只差一個字、單位對得上
 * @property {RosterEntry} entry 全部名單裡的那一位（這次不取消）
 * @property {RosterEntry} keepEntry 保留名單裡長得很像的那一位
 */

/**
 * @typedef {Object} RosterDiff
 * @property {RosterEntry[]} toRevoke 確定不在保留名單上，要取消的人
 * @property {RosterEntry[]} kept 確定在保留名單上的人
 * @property {UnitConflict[]} unitConflicts 同名但單位對不上（不動）
 * @property {TypoSuspect[]} typoSuspects 疑似抄錯字（不動）
 * @property {RosterEntry[]} keepUnmatched 保留名單裡在全部名單找不到、也不像抄錯字的人
 */

/** 單位前面常見、但兩份名單不一定都有寫的機關全名。 */
const UNIT_PREFIXES = ['桃園市政府消防局', '桃園市消防局', '消防局'];

/** 比對用的姓名：去掉所有空白（含全形）與姓名中間常見的間隔點。 */
export function normalizeName(name) {
  return String(name ?? '').replace(/[\s　．·‧・]/g, '');
}

/** 比對用的單位：去掉空白與前面的機關全名。 */
export function normalizeUnit(unit) {
  let text = String(unit ?? '').replace(/[\s　]/g, '');
  for (const prefix of UNIT_PREFIXES) {
    if (text.startsWith(prefix) && text.length > prefix.length) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text;
}

/**
 * 兩個單位算不算同一個：相同，或其中一個包含另一個
 * （「大溪分隊」對「第三救災救護大隊大溪分隊」）。
 */
export function unitsCompatible(unitA, unitB) {
  const left = normalizeUnit(unitA);
  const right = normalizeUnit(unitB);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** 兩個姓名是不是「一樣長、剛好只差一個字」（抄錯字的典型樣子）。 */
export function differsByOneChar(nameA, nameB) {
  const left = [...normalizeName(nameA)];
  const right = [...normalizeName(nameB)];
  if (left.length < 2 || left.length !== right.length) return false;
  return left.filter((char, index) => char !== right[index]).length === 1;
}

/**
 * 把保留名單依姓名分組（同名的人可能在不同單位）。
 *
 * @param {RosterEntry[]} keepEntries
 * @returns {Map<string, RosterEntry[]>}
 */
function groupByName(keepEntries) {
  const byName = new Map();
  for (const entry of keepEntries) {
    const key = normalizeName(entry.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }
  return byName;
}

/**
 * 從「保留名單沒有同名者」的人裡，挑出疑似抄錯字的（姓名只差一字、單位對得上）。
 *
 * @param {RosterEntry[]} candidates
 * @param {RosterEntry[]} unmatchedKeep
 * @returns {{toRevoke: RosterEntry[], typoSuspects: TypoSuspect[], explained: Set<RosterEntry>}}
 */
function separateTypos(candidates, unmatchedKeep) {
  const toRevoke = [];
  const typoSuspects = [];
  const explained = new Set();
  for (const entry of candidates) {
    const keepEntry = unmatchedKeep.find(
      (keep) => differsByOneChar(keep.name, entry.name) && unitsCompatible(keep.unit, entry.unit),
    );
    if (keepEntry) {
      typoSuspects.push({ entry, keepEntry });
      explained.add(keepEntry);
    } else {
      toRevoke.push(entry);
    }
  }
  return { toRevoke, typoSuspects, explained };
}

/**
 * 比對兩份名單。
 *
 * @param {RosterEntry[]} allEntries 全部名單
 * @param {RosterEntry[]} keepEntries 保留名單
 * @returns {RosterDiff}
 */
export function diffRosters(allEntries, keepEntries) {
  const keepByName = groupByName(keepEntries ?? []);
  /** 保留名單裡「有被對到」的人（同名就算，單位對不上也算——那已經列在存疑了）。 */
  const matchedKeep = new Set();
  const kept = [];
  const unitConflicts = [];
  const candidates = [];

  for (const entry of allEntries ?? []) {
    const sameName = keepByName.get(normalizeName(entry.name)) ?? [];
    const sameUnit = sameName.filter((keep) => unitsCompatible(keep.unit, entry.unit));
    for (const keep of sameName) matchedKeep.add(keep);
    if (sameUnit.length > 0) kept.push(entry);
    else if (sameName.length > 0) unitConflicts.push({ entry, keepUnits: sameName.map((keep) => keep.unit) });
    else candidates.push(entry);
  }

  const unmatchedKeep = (keepEntries ?? []).filter((keep) => !matchedKeep.has(keep));
  const { toRevoke, typoSuspects, explained } = separateTypos(candidates, unmatchedKeep);
  const keepUnmatched = unmatchedKeep.filter((keep) => !explained.has(keep));
  return { toRevoke, kept, unitConflicts, typoSuspects, keepUnmatched };
}
