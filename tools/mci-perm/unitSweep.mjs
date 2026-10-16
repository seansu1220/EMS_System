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
 * ⚠ 個資原則：本模組只取出結果表格的**姓名**與**帳號**兩欄（其餘欄位一概不讀）。
 *   兩者在畫面上本來就是遮過的（`許O軒`、`A1*****621`）；不連帳號一起抄，
 *   同單位兩位都顯示成 `李O城` 時就分不出是哪一位（2026-08-24 實跑踩過）。
 *   取出的內容只留在記憶體與 `out/` 底下的名單／結果檔，姓名寫進 log 前一律經過 `maskName`。
 */
import { SHOW_ALL_SWEEP, SITE, TIMING, UNIT_SWEEP } from './config.mjs';
import { clickMatch, findClickables, listOptions } from './domFind.mjs';
import {
  activePage,
  onSomeFrame,
  goToNextPage,
  openAccountPermissionPage,
  pageSignature,
  readResultNames,
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
 * 依名稱關鍵字把單位分成「要處理」與「不動」兩堆（「取消分隊權限」用）。
 *
 * 與 {@link splitUnits}（除了這幾個以外全部都要）和 {@link pickUnits}（只要指名的
 * 這幾個）都不同：這裡是**照名稱的型態**挑——單位名稱裡有「分隊」的才動，
 * 科室、大隊、中心一律維持現狀。使用者的話是「只有 OO 分隊要，科室或大隊維持現狀」，
 * 而分隊有幾十個且會增減，一個一個列進設定檔遲早會漏。
 *
 * ⚠ 一個都沒命中時**不要當成「沒事做」**：那代表系統換了單位的寫法
 *   （或關鍵字設錯），呼叫端要停手並印出實際的單位清單。
 *
 * @param {UnitOption[]} options 下拉裡的所有選項
 * @param {string[]} keywords 要處理的單位名稱關鍵字（**包含**比對，例如「分隊」）
 * @param {string[]} [keepUnits] 就算名稱符合也不動的單位（**包含**比對）
 * @param {string[]} [placeholders] 「請選擇」這類不是單位的選項
 * @returns {{targets: UnitOption[], skipped: UnitOption[], kept: UnitOption[], ignored: UnitOption[]}}
 *   `targets` 要處理；`kept` 是被保留清單擋下來的；`skipped` 是名稱型態不符（科室、大隊…）；
 *   `ignored` 不是單位（「請選擇」）
 */
export function splitUnitsByKeyword(
  options,
  keywords,
  keepUnits = [],
  placeholders = SITE.flow.unitPlaceholderTexts,
) {
  /** @type {UnitOption[]} */
  const targets = [];
  /** @type {UnitOption[]} */
  const skipped = [];
  /** @type {UnitOption[]} */
  const kept = [];
  /** @type {UnitOption[]} */
  const ignored = [];

  for (const option of options ?? []) {
    const text = String(option?.text ?? '').trim();
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
    if ((keywords ?? []).some((word) => word && squeeze(text).includes(squeeze(word)))) {
      targets.push(option);
      continue;
    }
    skipped.push(option);
  }
  return { targets, skipped, kept, ignored };
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
 * 把「畫面上顯示的姓名」拆成「可以拿去查的字」與「原樣」。
 *
 * ⚠ 這是 2026-08-23 首次實跑換來的：這個系統的查詢結果**不顯示完整姓名**，
 *   而是遮成 `許O軒`。把它當姓名去查一定是 0 筆——那次 239 位全滅。
 *
 * 作法是取**開頭沒被遮到的那一段**（幾乎都是姓氏）當查詢關鍵字，
 * 之後再從結果表格認出「顯示文字一模一樣」的那一列。開頭第一個字一定沒被遮
 * ——實跑 239 筆的四種樣式（`字O字`／`字O`／`字字OOO字字`／`字字字OOOOOO字字字`）
 * 都是如此。
 *
 * @param {string} displayName 畫面上看到的姓名
 * @param {string[]} [maskChars] 哪些字元算遮蔽符號
 * @returns {{searchName: string, masked: boolean}}
 *   `masked` 為 false 時代表這個名字沒被遮，可以直接當姓名查
 */
export function splitMaskedName(displayName, maskChars = SITE.flow.maskedNameChars) {
  const text = String(displayName ?? '').trim();
  const isMask = (char) => (maskChars ?? []).includes(char);
  if (!text || ![...text].some(isMask)) return { searchName: text, masked: false };

  let head = '';
  for (const char of text) {
    if (isMask(char)) break;
    head += char;
  }
  // 整個名字都被遮掉時沒有東西可查，退回用原字串（後續會如實回報查不到）。
  return { searchName: head || text, masked: true };
}

/**
 * 補上舊名單缺的 `searchName`／`rowText`。
 *
 * 2026-08-23 之前掃出來的名單只有 `name`（而且那是**遮蔽過的**姓名），
 * 直接拿去跑會整份「查無此人」。與其要使用者重掃十分鐘，不如讀回來時補算
 * ——這兩個欄位本來就是從 `name` 推出來的，不需要重新連線。
 *
 * @param {import('./roster.mjs').RosterEntry[]} entries
 * @returns {import('./roster.mjs').RosterEntry[]}
 */
export function withSearchNames(entries) {
  return (entries ?? []).map((entry) => {
    if (entry?.searchName) return entry;
    const { searchName, masked } = splitMaskedName(entry?.name);
    return { ...entry, searchName, rowText: masked ? entry.name : '' };
  });
}

/**
 * 掃出一個單位裡有哪些人。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {UnitOption} unitOption
 * @returns {Promise<{ok:boolean, people:{name:string, account:string}[],
 *   total:number|null, hasAccounts:boolean, reason?:string}>}
 */
export async function collectUnitRoster(session, unitOption) {
  // 每個單位都重新確認「現在在查詢頁」：已經在就直接用，不在才走選單回去
  //（處理完上一個單位可能停在別的畫面）。
  const opened = await openAccountPermissionPage(session);
  if (!opened.ok) {
    return { ok: false, people: [], total: null, hasAccounts: false, reason: `${opened.step}：${opened.detail}` };
  }

  // 姓名留空＝不限姓名，列出整個單位。
  const searched = await submitSearch(session, opened.frame, {
    unit: unitOption.text,
    unitValue: unitOption.value,
    name: '',
  });
  if (!searched.ok) {
    return { ok: false, people: [], total: null, hasAccounts: false, reason: `${searched.step}：${searched.detail}` };
  }

  const page = activePage(session);
  await waitWhileLoading(page);
  const total = await readStableCount(page);

  /** @type {{name:string, account:string}[]} */
  const people = [];
  // 去重的鍵是「姓名＋帳號」而不是只有姓名。
  // ⚠ 2026-08-24 實跑踩到的：同一個單位裡兩位都顯示成 `李O城`，
  //   只用姓名去重會把兩個人併成一筆——併掉的那位整份名單裡就消失了，
  //   而留下的那筆到了開通階段又會因為「同名兩列」而卡住，兩位都沒開到。
  const seen = new Set();
  let hasAccounts = false;

  let loggedHeaders = false;
  for (let pageIndex = 0; pageIndex < UNIT_SWEEP.maxPagesPerUnit; pageIndex += 1) {
    const column = await readResultNames(session);
    if (!column.ok) {
      // 第一頁就讀不到＝這個單位整個沒掃到，要讓呼叫端知道並跳過。
      // 已經讀到幾頁才失敗的話，寧可用已讀到的部分，也要如實說有問題。
      const detail = `${column.reason}${column.headers.length ? `（看到的欄位標題：${column.headers.join('、')}）` : ''}`;
      if (people.length === 0) return { ok: false, people, total, hasAccounts, reason: detail };
      return { ok: false, people, total, hasAccounts, reason: `第 ${pageIndex + 1} 頁${detail}` };
    }
    // 欄位標題屬表單結構、可安全記錄。成功時也留一行：系統改版時，
    // 這一行就是判斷「表格變成什麼樣子」的第一手線索（2026-08-23 那次
    // 就是因為只有失敗才記，才看不出姓名欄其實是遮蔽過的）。
    if (!loggedHeaders && column.headers.length > 0) {
      log.info(`    結果表格欄位：${column.headers.filter(Boolean).join('｜')}`);
      loggedHeaders = true;
    }

    const firstOnPage = column.values[0] ?? '';
    for (const [index, value] of column.values.entries()) {
      const name = String(value ?? '').trim();
      if (!name) continue;
      const account = String(column.accounts?.[index] ?? '').trim();
      if (account) hasAccounts = true;
      const key = `${name}｜${account}`;
      if (seen.has(key)) continue;
      seen.add(key);
      people.push({ name, account });
    }

    // 系統自己說共幾項，收滿就不必再翻（最後一頁的「下一頁」點下去也不會動，
    // 每個單位白等 6 秒，76 個單位就是快 8 分鐘）。
    if (total !== null && people.length >= total) break;
    if (!(await goToNextPage(session, firstOnPage, pageSignature(column)))) break;
  }

  return { ok: true, people, total, hasAccounts };
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

    for (const person of result.people) {
      const { searchName, masked } = splitMaskedName(person.name);
      entries.push({
        unit: unitOption.text,
        unitValue: unitOption.value,
        // 名字是**畫面上顯示的樣子**（可能被遮成 `許O軒`）。進度檔與結果清單都用它，
        // 因為那就是承辦人在系統上看得到的東西。
        name: person.name,
        // 拿去填「姓名」欄的字：遮蔽時只有沒被遮到的那一段能查。
        searchName,
        // 遮蔽時要靠「顯示文字」在結果表格裡認出是哪一列（見 grantFlow.locatePerson）。
        rowText: masked ? person.name : '',
        // 同一列上的帳號（也是遮過的）。遮蔽後撞名時，這是唯一分得出兩位的欄位。
        rowAccount: person.account,
        lineNumber: 0,
      });
    }

    if (!result.ok) {
      problems.push({ unit: unitOption.text, reason: result.reason ?? '掃不出這個單位的人' });
      log.warn(`${unitOption.text}：${result.reason}`);
      log.info(`  （這個單位只掃到 ${result.people.length} 位，其餘的人這次不會被動到）`);
    } else {
      const mismatch = result.total !== null && result.total !== result.people.length;
      log.ok(
        `${unitOption.text}：${result.people.length} 位` +
          `${mismatch ? `（系統顯示共 ${result.total} 項，姓名與帳號都一樣的已併成一筆）` : ''}`,
      );
      // 只印前幾位（已遮蔽）讓人看得出真的抓到人，不把整個單位洗到畫面上。
      if (result.people.length > 0) {
        log.info(`  例如：${result.people.slice(0, 3).map((person) => maskName(person.name)).join('、')}…`);
        // 系統本身就把姓名遮起來時要講明白：那決定了後面「怎麼查這個人」。
        const sample = splitMaskedName(result.people[0].name);
        if (sample.masked) {
          log.info(`  （系統顯示的姓名是遮蔽過的，之後會用「${sample.searchName}…」這樣的字查，再認出那一列）`);
        }
        // 有沒有抄到帳號決定「同名時分不分得出人」，掃描當下就要看得出來。
        log.info(
          result.hasAccounts
            ? '  （帳號欄有抄到，同名時靠它分辨是哪一位）'
            : '  ⚠ 這個單位讀不到帳號欄：萬一有同名的，程式會分不出是哪一位而跳過',
        );
      }
    }

    await activePage(session).waitForTimeout(UNIT_SWEEP.betweenUnitsMs);
  }

  return { entries, problems };
}

/**
 * @typedef {Object} ShowAllRow 「顯示全部」表格上的一列（都是畫面上顯示的樣子，姓名與帳號是遮過的）
 * @property {string} name
 * @property {string} account
 * @property {string} unit
 */

/**
 * 把「顯示全部」讀到的每一列，對回單位下拉的選項，組成可以逐位處理的名單。
 *
 * 純函式，有測試守著。為什麼要對回下拉：逐位處理時還是得「選單位＋填姓氏」
 * 查回這個人（見 grantFlow.locatePerson），而選單位要用下拉的 value 才精準。
 *
 * 三種人不會進名單：
 *   - 單位在保留清單裡（**包含**比對）→ 記進 `kept`，一個都不動
 *   - 表格上的單位在下拉裡找不到一模一樣的寫法 → 記進 `unmatched`（**不猜**：
 *     選錯單位就查不到人，或更糟——查到同單位同姓的另一位）
 *   - 姓名、帳號、單位三者都一樣的重複列 → 併成一筆
 *
 * @param {ShowAllRow[]} rows
 * @param {UnitOption[]} unitOptions 單位下拉的所有選項
 * @param {string[]} [keepUnits] 一個都不動的單位
 * @param {string[]} [placeholders] 「請選擇」這類不是單位的選項
 * @returns {{entries: import('./roster.mjs').RosterEntry[],
 *   kept: {unit: string, count: number}[],
 *   unmatched: {unit: string, count: number, reason: string, people: {name: string, account: string}[]}[],
 *   duplicateCount: number, blankNameCount: number}}
 */
export function buildShowAllEntries(rows, unitOptions, keepUnits = [], placeholders = SITE.flow.unitPlaceholderTexts) {
  const usable = (unitOptions ?? []).filter((option) => {
    const text = String(option?.text ?? '').trim();
    if (!text || !option?.value) return false;
    return !(placeholders ?? []).some((word) => squeeze(text) === squeeze(word));
  });

  /** @type {import('./roster.mjs').RosterEntry[]} */
  const entries = [];
  /** @type {Map<string, number>} */
  const kept = new Map();
  /** @type {Map<string, {count: number, reason: string, people: {name: string, account: string}[]}>} */
  const unmatched = new Map();
  const seen = new Set();
  let duplicateCount = 0;
  // 姓名格是空的列：多半不是人（分隔列），但一樣要算出來，總數才對得起來。
  let blankNameCount = 0;

  for (const row of rows ?? []) {
    const name = String(row?.name ?? '').trim();
    if (!name) {
      blankNameCount += 1;
      continue;
    }
    const account = String(row?.account ?? '').trim();
    const unit = String(row?.unit ?? '').trim();

    const key = `${name}｜${account}｜${unit}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);

    if (unit && (keepUnits ?? []).some((word) => word && squeeze(unit).includes(squeeze(word)))) {
      kept.set(unit, (kept.get(unit) ?? 0) + 1);
      continue;
    }

    const hits = usable.filter((option) => squeeze(option.text) === squeeze(unit));
    if (hits.length !== 1) {
      const label = unit || '（單位欄是空的）';
      const reason = hits.length === 0 ? '單位下拉裡沒有一模一樣的寫法' : `單位下拉裡有 ${hits.length} 個同名的選項，分不出是哪一個`;
      const previous = unmatched.get(label);
      // 連人一起記：承辦人要自己補做時，得知道是哪幾位。
      const people = [...(previous?.people ?? []), { name, account }];
      unmatched.set(label, { count: people.length, reason, people });
      continue;
    }

    const { searchName, masked } = splitMaskedName(name);
    entries.push({
      unit: hits[0].text,
      unitValue: hits[0].value,
      name,
      searchName,
      rowText: masked ? name : '',
      rowAccount: account,
      lineNumber: 0,
    });
  }

  return {
    entries,
    kept: [...kept.entries()].map(([unit, count]) => ({ unit, count })),
    unmatched: [...unmatched.entries()].map(([unit, value]) => ({ unit, ...value })),
    duplicateCount,
    blankNameCount,
  };
}

/** 在查詢頁按下「顯示全部」。 */
async function clickShowAll(session) {
  const found = await onSomeFrame(activePage(session), async (frame) => {
    const hits = await findClickables(frame, SITE.flow.showAllTexts, { exact: true });
    if (hits.length === 0) return null;
    return (await clickMatch(frame, SITE.flow.showAllTexts, 0, { exact: true })) ? true : null;
  });
  return Boolean(found);
}

/**
 * 按「顯示全部」，把全機關的人一頁一頁讀下來（只查詢，不改任何東西）。
 *
 * 使用者 2026-10-17 指定的掃法：查詢頁的「顯示全部」按下去就是全部的人
 *（2026-08-20 探測時是 2,258 項、226 頁），再從頁面下方的分頁一頁一頁翻。
 * 比「一個單位一個單位查」少選 76 次單位，也不會漏掉不在單位下拉裡的人
 * ——那種人會被列進 `problems`，讓承辦人看得到。
 *
 * ⚠ 讀不到「單位」欄就整支停手：沒有單位就無從查回這個人，
 *   硬做只會整份「查無此人」。
 *
 * @param {import('./session.mjs').PermSession} session
 * @returns {Promise<{rows: ShowAllRow[], total: number|null, problems: UnitProblem[]}>}
 */
export async function readShowAllRows(session) {
  const opened = await openAccountPermissionPage(session);
  if (!opened.ok) throw new Error(`進不去「帳號子系統權限」畫面：${opened.step}｜${opened.detail}`);

  if (!(await clickShowAll(session))) {
    throw new Error(`查詢頁上找不到「${SITE.flow.showAllTexts.join('／')}」按鈕，這次不動任何人`);
  }
  const page = activePage(session);
  await page.waitForTimeout(TIMING.querySettleMs);
  await waitWhileLoading(page);
  const total = await readStableCount(page);
  log.info(`  「顯示全部」：系統顯示共 ${total ?? '（讀不到）'} 項`);

  /** @type {ShowAllRow[]} */
  const rows = [];
  /** @type {UnitProblem[]} */
  const problems = [];

  for (let pageIndex = 0; pageIndex < SHOW_ALL_SWEEP.maxPages; pageIndex += 1) {
    const column = await readResultNames(session, { withUnits: true });
    if (!column.ok || (pageIndex === 0 && column.unitIndex < 0)) {
      const headers = column.headers.length ? `（看到的欄位標題：${column.headers.join('、')}）` : '';
      const reason = column.ok ? '結果表格裡找不到「單位」欄' : column.reason;
      if (pageIndex === 0) throw new Error(`讀不到「顯示全部」的結果：${reason}${headers}，這次不動任何人`);
      problems.push({ unit: '（顯示全部）', reason: `第 ${pageIndex + 1} 頁${reason}${headers}` });
      break;
    }
    if (pageIndex === 0) log.info(`    結果表格欄位：${column.headers.filter(Boolean).join('｜')}`);

    for (const [index, value] of column.values.entries()) {
      rows.push({ name: value, account: column.accounts[index] ?? '', unit: column.units[index] ?? '' });
    }
    if ((pageIndex + 1) % 20 === 0) log.info(`    已讀 ${pageIndex + 1} 頁、${rows.length} 列`);

    if (total !== null && rows.length >= total) break;
    if (!(await goToNextPage(session, column.values[0] ?? '', pageSignature(column)))) break;
  }

  // 少讀到人要講明白：沒讀到的人不會被處理，而且畫面上看不出來。
  if (total !== null && rows.length < total) {
    problems.push({
      unit: '（顯示全部）',
      reason: `系統說共 ${total} 項，只讀到 ${rows.length} 列（翻頁中斷）；沒讀到的人這次不會被處理，請加 --rescan 重掃`,
    });
  }
  return { rows, total, problems };
}

/**
 * 用「顯示全部」掃出全機關的名單，並對回單位下拉。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {UnitOption[]} unitOptions
 * @param {string[]} keepUnits 一個都不動的單位
 * @returns {Promise<{entries: import('./roster.mjs').RosterEntry[], problems: UnitProblem[]}>}
 */
export async function sweepShowAll(session, unitOptions, keepUnits) {
  const { rows, total, problems } = await readShowAllRows(session);
  const built = buildShowAllEntries(rows, unitOptions, keepUnits);

  // 每一列都要有去處，加起來要等於讀到的列數——對不上就是程式有漏洞，不是人事異動。
  const keptCount = built.kept.reduce((sum, hit) => sum + hit.count, 0);
  const unmatchedCount = built.unmatched.reduce((sum, miss) => sum + miss.count, 0);
  log.ok(
    `系統顯示共 ${total ?? '（讀不到）'} 項，讀到 ${rows.length} 列：` +
      `進名單 ${built.entries.length}、保留單位 ${keptCount}、單位對不上 ${unmatchedCount}、` +
      `重複 ${built.duplicateCount}、姓名空白 ${built.blankNameCount}`,
  );
  for (const hit of built.kept) log.ok(`  保留不動：${hit.unit} ${hit.count} 位`);
  for (const miss of built.unmatched) {
    log.warn(`  ${miss.unit}：${miss.count} 位沒辦法處理（${miss.reason}）`);
    const people = miss.people.map((person) => `${person.name}${person.account ? `（${person.account}）` : ''}`);
    problems.push({ unit: miss.unit, reason: `${miss.count} 位沒有處理：${miss.reason}；名單：${people.join('、')}` });
  }
  if (built.duplicateCount > 0) {
    problems.push({
      unit: '（顯示全部）',
      reason: `${built.duplicateCount} 列的姓名、帳號、單位與另一列完全一樣，已併成一筆；若其實是不同的人，請自己到系統確認`,
    });
  }
  return { entries: built.entries, problems };
}
