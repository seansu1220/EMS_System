/**
 * 取消「其他子系統」的權限：MCI、ACS、DQC 以外的 10 個子系統，有勾的全部取消。
 *
 * 使用者 2026-10-17 的要求：「把所有人除了 MCI 大傷系統、ACS 耗材管理系統以及
 * DQC DACPR 系統外，其他系統的權限都取消掉」。作法與大傷權限的取消一致——
 * **只取消子系統前面的勾選框**，角色下拉會跟著連動變回「請選擇權限」
 * （使用者確認過的系統行為）。
 *
 * 對每一位：查到這個人 → 按「設定」→ 讀 10 個子系統現在的樣子 →
 * 有勾的逐一取消 → 按確定 → 回頭再查一次，10 個都真的沒勾了才算成功。
 *
 * 設計原則（沿用 grantFlow.revokeOne）：
 *   - **一律用 id 定位**（`#ATM`／`#ATMselect`）：畫面上子系統名稱與下拉是錯開的
 *   - **10 個都沒勾的人一顆按鈕都不按**（全機關大多數人屬於這種）
 *   - **任何一個子系統讀不到就整位停手**：讀不到不等於沒權限，
 *     當成「本來就沒有」跳過的話，那個人會安靜地保有權限
 *   - 有一個勾選框取消不掉就**不按確定**：寧可這位整個重來，也不要存一半
 *
 * ⚠ 個資原則：姓名寫進 log 前一律經過 maskName（由呼叫端的批次迴圈處理）。
 */
import { CLEAR_OTHERS } from './config.mjs';
import { readSubsystemDom, setVisibleCheckbox } from './domFind.mjs';
import { locatePerson, OUTCOME, pressConfirm, runBatch } from './grantFlow.mjs';
import { log } from './logger.mjs';

/**
 * @typedef {Object} SubsystemSnapshot 一個子系統在權限畫面上的樣子
 * @property {string} code 畫面上的 id（例如 `ATM`、`VDS`）
 * @property {boolean} found 有沒有看到這個勾選框
 * @property {boolean} checked 勾選框是否勾著
 * @property {string} role 角色下拉目前顯示的文字
 */

/** 角色下拉「沒有權限」時顯示的字樣。 */
const NO_ROLE_TEXTS = ['請選擇權限', '請選擇', ''];

/** 比對用：去掉所有空白（含全形）。 */
function squeeze(text) {
  return String(text ?? '').replace(/[\s　]/g, '');
}

/**
 * 確認要取消的子系統清單沒有寫錯：不能空、不能重複、**不能碰到要保留的**。
 *
 * 純函式，有測試守著。設定檔手滑把 MCI 寫進取消清單，就是把整個機關的
 * 大傷權限一起拿掉——那正是使用者明講要留的東西，因此一有交集就丟錯停手。
 *
 * @param {string[]} clearCodes
 * @param {string[]} keepCodes
 * @returns {string[]} 去重後的取消清單
 */
export function resolveClearCodes(clearCodes, keepCodes) {
  const normalized = [...new Set((clearCodes ?? []).map((code) => String(code ?? '').trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('要取消的子系統清單是空的（config.mjs 的 CLEAR_OTHERS.clearCodes）');
  const keep = new Set((keepCodes ?? []).map((code) => String(code ?? '').trim().toUpperCase()));
  const overlap = normalized.filter((code) => keep.has(code.toUpperCase()));
  if (overlap.length > 0) {
    throw new Error(
      `要取消的子系統裡有要保留的「${overlap.join('、')}」，為了不誤清，這次停手不做` +
        '（請檢查 config.mjs 的 CLEAR_OTHERS.clearCodes）',
    );
  }
  return normalized;
}

/** 子系統給人看的名字（`VDS` 要翻成 FOS，不然承辦人看不懂）。 */
export function displayNameOf(code) {
  return CLEAR_OTHERS.displayNames[code] ?? code;
}

/**
 * 依現況把子系統分成三堆：要取消的、讀不到的、勾選框沒勾但下拉還顯示角色的。
 *
 * 純函式，有測試守著。判斷「有沒有權限」以**勾選框**為準（與大傷權限的取消一致）：
 * 送出去的就是勾選框。第三堆只是記下來給人看，不會因此去動它。
 *
 * @param {SubsystemSnapshot[]} snapshots
 * @returns {{toClear: SubsystemSnapshot[], unreadable: SubsystemSnapshot[],
 *   roleWithoutCheck: SubsystemSnapshot[]}}
 */
export function planSubsystemClear(snapshots) {
  const toClear = [];
  const unreadable = [];
  const roleWithoutCheck = [];
  for (const snapshot of snapshots ?? []) {
    if (!snapshot.found) unreadable.push(snapshot);
    else if (snapshot.checked) toClear.push(snapshot);
    else if (!NO_ROLE_TEXTS.some((text) => squeeze(snapshot.role) === squeeze(text))) roleWithoutCheck.push(snapshot);
  }
  return { toClear, unreadable, roleWithoutCheck };
}

/**
 * 把幾個子系統寫成一行給人看：「ATM（ATM003 一般使用者）、AAM（…）」。
 *
 * @param {SubsystemSnapshot[]} snapshots
 * @returns {string}
 */
export function describeSnapshots(snapshots) {
  return (snapshots ?? [])
    .map((snapshot) => `${displayNameOf(snapshot.code).split(' ')[0]}（${snapshot.role || '沒有選'}）`)
    .join('、');
}

/**
 * 讀出這幾個子系統**畫面上那一組**勾選框與下拉現在的樣子。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} codes
 * @returns {Promise<SubsystemSnapshot[]>}
 */
async function readSnapshots(frame, codes) {
  const snapshots = [];
  for (const code of codes) {
    const dom = await readSubsystemDom(frame, `#${code}`, `#${code}select`).catch(() => null);
    const found = Boolean(dom && dom.checkbox.visibleCount > 0);
    snapshots.push({ code, found, checked: found && dom.checkbox.checked === true, role: dom?.role.text ?? '' });
  }
  return snapshots;
}

/**
 * 把這幾個子系統的勾選框逐一取消。
 *
 * @returns {Promise<{ok: boolean, failed: string[]}>} `failed`＝取消不掉的子系統代碼
 */
async function uncheckAll(frame, snapshots) {
  const failed = [];
  for (const snapshot of snapshots) {
    const result = await setVisibleCheckbox(frame, `#${snapshot.code}`, false).catch(() => null);
    if (!result?.ok || result.checked) failed.push(snapshot.code);
  }
  return { ok: failed.length === 0, failed };
}

/**
 * 按完確定之後，回頭再查一次這個人，確認那幾個子系統真的都沒勾了。
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function verifyCleared(session, entry, codes) {
  const again = await locatePerson(session, entry);
  if (!again.ok) return { ok: false, detail: `回頭查不回這個人（${again.detail}）——請自己到系統確認` };

  const after = await readSnapshots(again.frame, codes);
  const { toClear: stillChecked, unreadable, roleWithoutCheck } = planSubsystemClear(after);
  if (stillChecked.length > 0) {
    return { ok: false, detail: `回頭查證發現仍然勾著：${describeSnapshots(stillChecked)}——請自己到系統確認` };
  }
  if (unreadable.length > 0) {
    return { ok: false, detail: `回頭查證時讀不到 ${unreadable.map((item) => item.code).join('、')}——請自己到系統確認` };
  }
  // 勾選框都取消了，但下拉沒有跟著連動：權限以勾選框為準，記下來給人看就好。
  const note = roleWithoutCheck.length > 0 ? `（下拉仍顯示：${describeSnapshots(roleWithoutCheck)}）` : '';
  return { ok: true, detail: `回頭查證：確實都已取消勾選${note}` };
}

/**
 * 取消一位人員在「其他子系統」的權限。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {import('./roster.mjs').RosterEntry} entry
 * @param {{execute?: boolean, verify?: boolean}} [options]
 * @returns {Promise<import('./grantFlow.mjs').GrantResult>}
 */
export async function clearOthersOne(session, entry, options = {}) {
  const base = { unit: entry.unit, name: entry.name, account: entry.rowAccount ?? '' };
  const codes = resolveClearCodes(CLEAR_OTHERS.clearCodes, CLEAR_OTHERS.keepCodes);

  const located = await locatePerson(session, entry);
  if (!located.ok) return { ...base, ...located.result };

  const before = await readSnapshots(located.frame, codes);
  const { toClear, unreadable, roleWithoutCheck } = planSubsystemClear(before);
  if (unreadable.length > 0) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '檢查現況',
      detail: `權限畫面上讀不到 ${unreadable.map((item) => displayNameOf(item.code)).join('、')} 的勾選框，這位沒有動（系統可能改版）`,
    };
  }
  const mismatchNote =
    roleWithoutCheck.length > 0 ? `；另有勾選框沒勾、下拉卻顯示角色的：${describeSnapshots(roleWithoutCheck)}（沒有動它）` : '';
  if (toClear.length === 0) {
    return {
      ...base,
      outcome: OUTCOME.alreadyRevoked,
      step: '檢查現況',
      detail: `${codes.length} 個子系統本來就都沒有勾選，沒有動它${mismatchNote}`,
    };
  }
  log.info(`  目前有勾的：${describeSnapshots(toClear)} → 取消勾選`);

  if (!options.execute) {
    return {
      ...base,
      outcome: OUTCOME.dryRun,
      step: '停在取消之前',
      detail: `會取消 ${toClear.length} 個：${describeSnapshots(toClear)}；試跑不會取消，加 --execute 才會${mismatchNote}`,
    };
  }

  const unchecked = await uncheckAll(located.frame, toClear);
  if (!unchecked.ok) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '取消勾選',
      detail: `${unchecked.failed.join('、')} 的勾選框點不動，為了不存一半，這位沒有按確定（等於都沒有取消）`,
    };
  }

  const confirmed = await pressConfirm(session);
  if (!confirmed.ok) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '按確定',
      detail: '勾選已取消，但一顆送出的按鈕都按不到（等於沒有取消）',
    };
  }
  log.info(`  按下：${confirmed.pressed.join(' → ')}`);

  const done = `已取消 ${toClear.length} 個：${describeSnapshots(toClear)}，並按下「${confirmed.pressed.join('」→「')}」`;
  if (options.verify === false) {
    return { ...base, outcome: OUTCOME.revoked, step: '完成（未回讀驗證）', detail: done };
  }
  const verified = await verifyCleared(session, entry, codes);
  return {
    ...base,
    outcome: verified.ok ? OUTCOME.revoked : OUTCOME.failed,
    step: verified.ok ? '完成（已回讀確認）' : '回讀驗證',
    detail: `${done}；${verified.detail}`,
  };
}

/**
 * 依名單逐一取消（批次迴圈、續跑、登入檢查都沿用 grantFlow 的 runBatch）。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {import('./roster.mjs').RosterEntry[]} entries
 * @param {object} [options]
 */
export async function clearOthersAll(session, entries, options = {}) {
  // 開跑前先檢查一次清單，寫錯就一個人都不碰（不要等到第一位才發現）。
  resolveClearCodes(CLEAR_OTHERS.clearCodes, CLEAR_OTHERS.keepCodes);
  return runBatch(session, entries, options, clearOthersOne);
}
