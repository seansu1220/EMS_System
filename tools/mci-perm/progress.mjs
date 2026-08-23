/**
 * 開通進度：**做過的人記下來，下次接著跑**。
 *
 * 為什麼需要：使用者 2026-08-20 的名單有 1890 位，跑完約 10 小時。
 * 這中間登入一定會被伺服器踢好幾次，視窗也可能被關掉——
 * 沒有進度檔的話每次都得從第一位重來，而重來一次就是十小時。
 *
 * 格式刻意用 **JSON Lines（一行一筆）**：每做完一位就追加一行，
 * 不必把整份 1890 筆重寫一次；中途斷電也只會壞掉最後一行，前面的都還在。
 *
 * ⚠ 個資原則：這個檔案含姓名，只落在本工具的 `out/progress/`
 *   （`.gitignore` 已排除 `tools/**\/out/`），不上雲、不進版控。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { OUTCOME, SETTLED_OUTCOMES } from './grantFlow.mjs';

/**
 * @typedef {Object} ProgressRecord
 * @property {string} outcome 上次的結果（{@link OUTCOME} 之一）
 * @property {string} detail 上次的說明
 * @property {string} at 上次處理的時間（ISO）
 */

/**
 * 一位人員在進度檔裡的識別。
 *
 * 用「單位＋姓名」而不是只用姓名：不同單位的同名者是兩個人，
 * 只看姓名會讓其中一位被誤認成做過了。
 */
export function entryKey(entry) {
  return `${entry.unit}｜${entry.name}`;
}

/**
 * 這一筆算「做完了」嗎（下次可以跳過）。
 *
 * **只有真的成功才算**：查無此人、查到不只一人、失敗都要再試一次——
 * 那些多半是暫時狀況（掉線、名單打錯後修正、系統當下卡住），
 * 直接跳過會讓人默默漏掉權限。
 *
 * @param {ProgressRecord|undefined} record
 */
export function isDone(record) {
  if (!record) return false;
  // 試跑不算做完（沒有真的動到系統）。
  if (record.outcome === OUTCOME.dryRun) return false;
  return SETTLED_OUTCOMES.includes(record.outcome);
}

/**
 * 依名單來源決定進度檔位置。
 *
 * 同一份名單再跑就會接上同一個進度檔；換一份名單則各記各的。
 * @param {string} sourceLabel 名單檔路徑；貼上的名單給空字串
 */
export function progressFileFor(sourceLabel) {
  const base = sourceLabel ? path.basename(sourceLabel).replace(/[\\/:*?"<>|]/g, '_') : '貼上的名單';
  return path.join(PATHS.progressDir, `${base}.jsonl`);
}

/**
 * 掃單位那類指令（全面取消、開通大隊權限）的進度檔位置。
 *
 * 刻意**每一種各記一份**：它們的名單來源完全不同（貼上的名單／全機關／指定的大隊），
 * 混在同一個檔案會互相蓋掉，也看不出誰是誰。
 *
 * @param {string} label 這件事的名字（同時也是檔名），例如「全面取消」
 */
export function sweepProgressFile(label) {
  return path.join(PATHS.progressDir, `${label}.jsonl`);
}

/**
 * 掃出來的名單快取。
 *
 * 掃 76 個單位要十分鐘上下，而這件事**跑到一半被中斷是常態**（要跑好幾個小時）。
 * 存起來之後，續跑就直接接著做人，不必每次重掃一次。
 * 要重新掃（例如中間有人事異動）用 `--rescan`。
 *
 * @param {string} label 與 {@link sweepProgressFile} 用同一個
 */
export function sweepRosterFile(label) {
  return path.join(PATHS.progressDir, `${label}-名單.json`);
}

/**
 * 把掃出來的名單存起來。
 *
 * ⚠ 含姓名，只落在 `out/progress/`（`.gitignore` 已排除 `tools/**\/out/`）。
 *
 * @param {string} filePath
 * @param {import('./roster.mjs').RosterEntry[]} entries
 */
export async function saveRoster(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = { savedAt: new Date().toISOString(), entries };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * 讀回上次掃出來的名單（沒有、或讀不懂就當成「還沒掃過」）。
 *
 * @param {string} filePath
 * @returns {Promise<{entries: import('./roster.mjs').RosterEntry[], savedAt: string}>}
 */
export async function loadRoster(filePath) {
  try {
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    return { entries, savedAt: String(payload?.savedAt ?? '') };
  } catch {
    // 沒有檔案＝第一次跑；壞掉的檔案重掃一次就好，不值得讓整個流程失敗。
    return { entries: [], savedAt: '' };
  }
}

/**
 * 讀進度檔。
 *
 * 讀不懂的行**一律跳過而不是整份放棄**：斷電時最後一行可能只寫了一半，
 * 為了那一行讓前面 1800 筆重跑完全不划算。
 *
 * @param {string} filePath
 * @returns {Promise<Map<string, ProgressRecord>>}
 */
export async function loadProgress(filePath) {
  /** @type {Map<string, ProgressRecord>} */
  const progress = new Map();
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return progress; // 沒有檔案＝第一次跑，正常
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.key) progress.set(record.key, record);
    } catch {
      // 壞掉的一行不影響其他行。
    }
  }
  return progress;
}

/**
 * 追加一筆進度（做完一位就寫一次）。
 *
 * 寫檔失敗**只警告不中斷**：權限已經開好了，不該因為記錄失敗就讓整批停下來。
 *
 * @param {string} filePath
 * @param {import('./roster.mjs').RosterEntry} entry
 * @param {{outcome: string, detail: string}} result
 */
export async function appendProgress(filePath, entry, result) {
  const record = {
    key: entryKey(entry),
    unit: entry.unit,
    name: entry.name,
    outcome: result.outcome,
    detail: result.detail,
    at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * 依進度把名單分成「這次要做的」與「上次已經做完的」。
 *
 * @param {import('./roster.mjs').RosterEntry[]} entries
 * @param {Map<string, ProgressRecord>} progress
 * @returns {{todo: import('./roster.mjs').RosterEntry[],
 *   skipped: {entry: import('./roster.mjs').RosterEntry, record: ProgressRecord}[]}}
 */
export function splitByProgress(entries, progress) {
  const todo = [];
  const skipped = [];
  for (const entry of entries) {
    const record = progress.get(entryKey(entry));
    if (isDone(record)) skipped.push({ entry, record });
    else todo.push(entry);
  }
  return { todo, skipped };
}

/**
 * 把上次的進度做成一份可以直接看的摘要（給終端機用，姓名由呼叫端遮蔽）。
 * @param {Map<string, ProgressRecord>} progress
 * @returns {Record<string, number>}
 */
export function countByOutcome(progress) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const record of progress.values()) {
    counts[record.outcome] = (counts[record.outcome] ?? 0) + 1;
  }
  return counts;
}
