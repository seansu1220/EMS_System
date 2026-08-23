/**
 * 單位掃描：把「每個單位裡有哪些人」抓出來。
 *
 * 這是「全面取消」（把所有人的 MCI 權限拿掉）的第一步。原因很單純：
 * 系統沒有「列出全機關所有人」的畫面，只能**一個單位一個單位查**——
 * 單位下拉逐一選過去、姓名留空按搜尋，再從結果表格讀「姓名」欄。
 *
 * 掃完之後，名單就跟使用者自己貼進來的名單長得一模一樣，
 * 直接交給 `grantFlow.revokeAll()` 逐一處理即可（不另外寫一套取消流程）。
 *
 * 設計原則：
 *   - **沿用既有實作**：查詢用 `submitSearch`、筆數用 `readStableCount`、
 *     進頁面用 `openAccountPermissionPage`。掃描與正式流程對「查到幾個人」
 *     的判斷若不一致，掃出來的名單就不能信。
 *   - **看不懂就跳過整個單位**，不猜：讀不到姓名欄時記下原因、繼續下一個單位，
 *     那個單位的人這次一個都不會被動到（少做比做錯好）。
 *
 * ⚠ 個資原則：本模組會取出**姓名**（不取姓名以外的任何欄位）。
 *   姓名只留在記憶體與 `out/` 底下的名單／結果檔，寫進 log 前一律經過 `maskName`。
 */
import { SITE, TIMING, UNIT_SWEEP } from './config.mjs';
import { clickMatch, findClickables, listOptions, readResultColumn } from './domFind.mjs';
import {
  activePage,
  onSomeFrame,
  openAccountPermissionPage,
  readStableCount,
  submitSearch,
  waitWhileLoading,
} from './grantFlow.mjs';
import { log, maskName } from './logger.mjs';

/**
 * @typedef {Object} UnitOption
 * @property {string} value 下拉選項的 value（拿它選最精準）
 * @property {string} text 顯示名稱
 */

/**
 * @typedef {Object} UnitProblem
 * @property {string} unit
 * @property {string} reason 這個單位為什麼沒掃成功（訊息裡不含姓名）
 */

/** 比對用：去掉所有空白（含全形）。 */
function squeeze(text) {
  return String(text ?? '').replace(/[\s　]/g, '');
}

/**
 * 把單位下拉的選項分成三堆：要清空的、要保留的、不是單位的。
 *
 * 純函式，有測試守著——這是整個「全面取消」最不能出錯的一步：
 * 少留一個單位，就是把不該動的人的權限拿掉了。
 *
 * @param {UnitOption[]} options 下拉裡的所有選項
 * @param {string[]} keepUnits 要保留的單位（**包含**比對，寫一部分也認得）
 * @param {string[]} [placeholders] 「請選擇」這類不是單位的選項
 * @returns {{targets: UnitOption[], kept: UnitOption[], ignored: UnitOption[]}}
 */
export function splitUnits(options, keepUnits, placeholders = SITE.flow.unitPlaceholderTexts) {
  /** @type {UnitOption[]} */
  const targets = [];
  /** @type {UnitOption[]} */
  const kept = [];
  /** @type {UnitOption[]} */
  const ignored = [];

  for (const option of options ?? []) {
    const text = String(option?.text ?? '').trim();
    // 沒有 value 的選項就是「請選擇」那一個（選了等於沒選）。
    if (!text || !option?.value) {
      ignored.push(option);
      continue;
    }
    if ((placeholders ?? []).some((word) => squeeze(text) === squeeze(word))) {
      ignored.push(option);
      continue;
    }
    if ((keepUnits ?? []).some((word) => word && squeeze(text).includes(squeeze(word)))) {
      kept.push(option);
      continue;
    }
    targets.push(option);
  }
  return { targets, kept, ignored };
}

/**
 * 挑出名稱含指定關鍵字的單位（「開通大隊權限」用）。
 *
 * 與 {@link splitUnits} 相反：那個是「除了這幾個以外全部都要」，
 * 這個是「只要這幾個」。
 *
 * ⚠ `missing` 是**寫法在下拉裡完全找不到**的關鍵字。呼叫端一律據此停手：
 *   少開一個大隊是很難事後發現的錯（畫面上看起來一切正常，只是那個大隊沒開到），
 *   寧可停下來讓人把名稱改對。
 *
 * @param {UnitOption[]} options 下拉裡的所有選項
 * @param {string[]} wantedUnits 要處理的單位（**包含**比對，寫一部分也認得）
 * @param {string[]} [placeholders] 「請選擇」這類不是單位的選項
 * @returns {{targets: UnitOption[], matched: {wanted: string, units: string[]}[], missing: string[]}}
 */
export function pickUnits(options, wantedUnits, placeholders = SITE.flow.unitPlaceholderTexts) {
  const usable = (options ?? []).filter((option) => {
    const text = String(option?.text ?? '').trim();
    if (!text || !option?.value) return false;
    return !(placeholders ?? []).some((word) => squeeze(text) === squeeze(word));
  });

  /** @type {UnitOption[]} */
  const targets = [];
  /** @type {{wanted: string, units: string[]}[]} */
  const matched = [];
  /** @type {string[]} */
  const missing = [];

  for (const wanted of wantedUnits ?? []) {
    const hits = usable.filter((option) => squeeze(option.text).includes(squeeze(wanted)));
    if (hits.length === 0) {
      missing.push(wanted);
      continue;
    }
    matched.push({ wanted, units: hits.map((option) => option.text) });
    // 兩個關鍵字命中同一個單位時只算一次（否則那個單位的人會被跑兩遍）。
    for (const hit of hits) {
      if (!targets.includes(hit)) targets.push(hit);
    }
  }
  return { targets, matched, missing };
}

/**
 * 只留下名稱符合的單位（`--unit=` 用：先拿一個小單位試跑，確認流程正確再跑全部）。
 *
 * @param {UnitOption[]} targets
 * @param {string} keyword
 * @returns {UnitOption[]}
 */
export function filterUnits(targets, keyword) {
  const wanted = squeeze(keyword);
  if (!wanted) return targets;
  return (targets ?? []).filter((option) => squeeze(option.text).includes(wanted));
}

/**
 * 只留下單位名稱相符的人。
 *
 * `--unit=` 沿用**上次掃到的整份名單**時要用：名單裡是全機關的人，
 * 不篩的話 `--unit` 等於沒下，一個「只想先試一個單位」的指令就變成跑全部。
 *
 * @param {import('./roster.mjs').RosterEntry[]} entries
 * @param {string} keyword
 * @returns {import('./roster.mjs').RosterEntry[]}
 */
export function filterEntriesByUnit(entries, keyword) {
  const wanted = squeeze(keyword);
  if (!wanted) return entries ?? [];
  return (entries ?? []).filter((entry) => squeeze(entry.unit).includes(wanted));
}

/**
 * 讀出單位下拉裡的所有選項。
 *
 * @param {import('playwright-core').Frame} frame 查詢頁所在的 frame
 * @returns {Promise<UnitOption[]>}
 */
export async function readUnitOptions(frame) {
  const options = await listOptions(frame, SITE.flow.querySelectors.unit);
  return options ?? [];
}

/**
 * 讀目前這一頁結果表格的「姓名」欄。
 *
 * 用 `onSomeFrame` 是因為結果表不一定跟查詢表單在同一個 frame
 *（這個系統的版面在不同畫面之間會換）。
 *
 * @returns {Promise<{ok:boolean, values:string[], headers:string[], reason?:string}>}
 */
async function readNameColumn(session) {
  /** 讀不到時，把「這個 frame 看到了哪些欄位標題」留下來當排查線索。 */
  let diagnosis = null;

  for (const frame of activePage(session).frames()) {
    const result = await readResultColumn(frame, SITE.flow.resultNameHeaders, SITE.flow.rowActionTexts).catch(
      () => null,
    );
    if (result?.ok) return result;
    if (result && !diagnosis) diagnosis = result;
  }
  return {
    ok: false,
    values: [],
    headers: diagnosis?.headers ?? [],
    reason: diagnosis?.reason ?? '讀不到查詢結果表格',
  };
}

/**
 * 按「下一頁」，並確認表格**真的換頁了**。
 *
 * ⚠ 最後一頁的「下一頁」按鈕仍然點得下去，只是畫面不會變。
 *   所以不能「點到了就當成翻頁成功」——那會讓同一頁被重複讀，
 *   而重複的姓名會蓋掉「還沒讀到的人」的位置，整個單位就漏了。
 *   判定方式是「第一列的姓名變了」。
 *
 * @param {string} firstNameBefore 翻頁前第一列的姓名
 * @returns {Promise<boolean>} 有沒有真的翻到下一頁
 */
async function goToNextPage(session, firstNameBefore) {
  const page = activePage(session);
  const clicked = await onSomeFrame(page, async (frame) => {
    const hits = await findClickables(frame, SITE.flow.nextPageTexts, { exact: true });
    if (hits.length === 0) return null;
    return (await clickMatch(frame, SITE.flow.nextPageTexts, 0, { exact: true })) ? hits : null;
  });
  if (!clicked) return false;

  const deadline = Date.now() + TIMING.pageTurnTimeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(TIMING.pollIntervalMs);
    const column = await readNameColumn(session);
    if (column.ok && column.values[0] && column.values[0] !== firstNameBefore) return true;
  }
  return false;
}

/**
 * 掃出一個單位裡有哪些人。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {UnitOption} unitOption
 * @returns {Promise<{ok:boolean, names:string[], total:number|null, reason?:string}>}
 */
export async function collectUnitRoster(session, unitOption) {
  // 每個單位都重新確認「現在在查詢頁」：已經在就直接用，不在才走選單回去
  //（處理完上一個單位可能停在別的畫面）。
  const opened = await openAccountPermissionPage(session);
  if (!opened.ok) return { ok: false, names: [], total: null, reason: `${opened.step}：${opened.detail}` };

  // 姓名留空＝不限姓名，列出整個單位。
  const searched = await submitSearch(session, opened.frame, {
    unit: unitOption.text,
    unitValue: unitOption.value,
    name: '',
  });
  if (!searched.ok) return { ok: false, names: [], total: null, reason: `${searched.step}：${searched.detail}` };

  const page = activePage(session);
  await waitWhileLoading(page);
  const total = await readStableCount(page);

  /** @type {string[]} */
  const names = [];
  const seen = new Set();

  for (let pageIndex = 0; pageIndex < UNIT_SWEEP.maxPagesPerUnit; pageIndex += 1) {
    const column = await readNameColumn(session);
    if (!column.ok) {
      // 第一頁就讀不到＝這個單位整個沒掃到，要讓呼叫端知道並跳過。
      // 已經讀到幾頁才失敗的話，寧可用已讀到的部分，也要如實說有問題。
      const detail = `${column.reason}${column.headers.length ? `（看到的欄位標題：${column.headers.join('、')}）` : ''}`;
      if (names.length === 0) return { ok: false, names, total, reason: detail };
      return { ok: false, names, total, reason: `第 ${pageIndex + 1} 頁${detail}` };
    }

    const firstOnPage = column.values[0] ?? '';
    for (const value of column.values) {
      const name = String(value ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }

    // 系統自己說共幾項，收滿就不必再翻（最後一頁的「下一頁」點下去也不會動，
    // 每個單位白等 6 秒，76 個單位就是快 8 分鐘）。
    if (total !== null && names.length >= total) break;
    if (!(await goToNextPage(session, firstOnPage))) break;
  }

  return { ok: true, names, total };
}

/**
 * 掃過所有要處理的單位，組成一份「單位＋姓名」的名單。
 *
 * 一個單位掃不出來**不影響其他單位**：記進 `problems` 繼續下一個，
 * 最後一起寫進結果檔，承辦人看得出哪幾個單位要自己確認。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {UnitOption[]} targets
 * @returns {Promise<{entries: import('./roster.mjs').RosterEntry[], problems: UnitProblem[]}>}
 */
export async function sweepAllUnits(session, targets) {
  /** @type {import('./roster.mjs').RosterEntry[]} */
  const entries = [];
  /** @type {UnitProblem[]} */
  const problems = [];

  for (const [index, unitOption] of (targets ?? []).entries()) {
    log.step(`[掃描 ${index + 1}/${targets.length}] ${unitOption.text}`);
    const result = await collectUnitRoster(session, unitOption);

    for (const name of result.names) {
      entries.push({ unit: unitOption.text, unitValue: unitOption.value, name, lineNumber: 0 });
    }

    if (!result.ok) {
      problems.push({ unit: unitOption.text, reason: result.reason ?? '掃不出這個單位的人' });
      log.warn(`${unitOption.text}：${result.reason}`);
      log.info(`  （這個單位只掃到 ${result.names.length} 位，其餘的人這次不會被動到）`);
    } else {
      const mismatch = result.total !== null && result.total !== result.names.length;
      log.ok(
        `${unitOption.text}：${result.names.length} 位` +
          `${mismatch ? `（系統顯示共 ${result.total} 項，同名的已併成一筆）` : ''}`,
      );
      // 只印前幾位（已遮蔽）讓人看得出真的抓到人，不把整個單位洗到畫面上。
      if (result.names.length > 0) {
        log.info(`  例如：${result.names.slice(0, 3).map(maskName).join('、')}…`);
      }
    }

    await activePage(session).waitForTimeout(UNIT_SWEEP.betweenUnitsMs);
  }

  return { entries, problems };
}
