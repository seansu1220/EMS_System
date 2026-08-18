/**
 * 開通流程：把「右上角你好 → 帳號子系統權限 → 查人 → 設定 → 選 MCI002 → 確定」
 * 這六步做成程式。
 *
 * 設計原則：
 *   - **定位以畫面文字為主、id 為輔**（見 domFind.mjs）。但有兩處**一定要用 id**，
 *     是 2026-08-18 實跑換來的教訓：
 *       1. 查詢區（`#searchDeptNotNfa` 等）——這一頁同時藏著「新增」與「編輯」
 *          兩整組同名欄位，用標籤會挑到隱藏的那一組
 *       2. 權限區（`#MCIselect`、`#MCI`）——畫面上子系統名稱與下拉是**錯開的**，
 *          用文字定位會設到隔壁那個子系統去（那才是真正會出事的錯誤）
 *   - **每一步失敗都要說得出「卡在哪、畫面上有什麼」**：政府系統改版時，
 *     這份候選清單就是修好它的全部線索，不必請使用者抄畫面。
 *   - **看不懂的情況一律停手**：查到不只一個人、下拉有多個相符選項時絕不亂點，
 *     幫錯人開權限比漏開嚴重得多。
 *   - 預設是**試跑**：走到最後一步就停，不按「確定」。要真的開通得加 --execute。
 *
 * ⚠ 個資原則：姓名只在填入欄位時使用，寫進 log 前一律經過 maskName。
 */
import { SITE, TIMING } from './config.mjs';
import {
  clickMatch,
  findClickables,
  findField,
  hasText,
  matchText,
  listClickableTexts,
  listFields,
  listSelects,
  rowAction,
  selectOptionByText,
  selectOptionInRow,
  setField,
} from './domFind.mjs';
import { log, maskName } from './logger.mjs';

/** 一位人員的處理結果。 */
export const OUTCOME = {
  /** 真的按下確定並完成。 */
  granted: '已開通',
  /** 試跑：一路走到最後，但沒有按確定。 */
  dryRun: '試跑通過（未按確定）',
  /** 查詢結果 0 筆。 */
  notFound: '查無此人',
  /** 查詢結果超過 1 筆，沒有把握是哪一個，停手。 */
  multiple: '查到不只一人',
  /** 中途出錯。 */
  failed: '失敗',
};

/**
 * @typedef {Object} GrantResult
 * @property {string} unit
 * @property {string} name
 * @property {string} outcome {@link OUTCOME} 之一
 * @property {string} step 走到（或卡在）哪一步
 * @property {string} detail 白話說明
 * @property {string[]} [candidates] 卡住時畫面上看得到的東西，供事後排查
 */

/** 目前真正在操作的頁：點「設定」若開了新視窗，要跟著換過去。 */
function activePage(session) {
  const pages = session.context.pages().filter((page) => !page.isClosed());
  return pages[pages.length - 1] ?? session.page;
}

/**
 * 依序在每個 frame 上試同一件事，回傳第一個成功的。
 *
 * 刻意不假設版面是不是 frameset：這個系統還沒探測過，
 * 內容可能在主文件，也可能在某個 frame 裡。
 *
 * @template T
 * @param {import('playwright-core').Page} page
 * @param {(frame: import('playwright-core').Frame) => Promise<T|null|false>} action
 * @returns {Promise<{frame: import('playwright-core').Frame, value: T}|null>}
 */
async function onSomeFrame(page, action) {
  for (const frame of page.frames()) {
    const value = await action(frame).catch(() => null);
    if (value) return { frame, value };
  }
  return null;
}

/**
 * 反覆試到成功或放棄（頁面換版面、資料還在載入時很常見）。
 * @template T
 * @param {() => Promise<T|null|false>} action
 * @returns {Promise<T|null>}
 */
async function retry(action, page, times = TIMING.retryTimes, intervalMs = TIMING.retryIntervalMs) {
  for (let attempt = 0; attempt < times; attempt += 1) {
    const value = await action().catch(() => null);
    if (value) return value;
    if (attempt < times - 1) await page.waitForTimeout(intervalMs);
  }
  return null;
}

/** 畫面上目前看得到什麼（卡住時的排查線索；已遮蔽長數字）。 */
async function describeScreen(page, limit = 40) {
  const texts = [];
  for (const frame of page.frames()) {
    const clickables = await listClickableTexts(frame, limit).catch(() => []);
    for (const item of clickables) {
      if (!texts.includes(item.text)) texts.push(item.text);
    }
  }
  return texts.slice(0, limit);
}

/** 畫面上有哪些欄位（找不到姓名欄之類的情況要用）。 */
async function describeFields(page) {
  const described = [];
  for (const frame of page.frames()) {
    const fields = await listFields(frame).catch(() => []);
    for (const field of fields) {
      if (!field.visible) continue;
      const text = `${field.nearbyText || '(沒有標籤)'}［${field.tag}${field.type ? ':' + field.type : ''}］`;
      if (!described.includes(text)) described.push(text);
    }
  }
  return described.slice(0, 40);
}

/** 這個 frame 裡有沒有這個選擇器指到的元素。 */
async function hasSelector(frame, selector) {
  if (!selector) return false;
  return (await frame.locator(selector).count().catch(() => 0)) > 0;
}

/**
 * 等一個下拉「有東西可選」。
 *
 * 這一頁的單位清單是進頁面後才由伺服器載入的，剛到站時是空的；
 * 不等就選，結果會是「沒有相符的選項」——看起來像單位打錯，其實只是還沒載入。
 *
 * @returns {Promise<boolean>} 逾時前有沒有等到
 */
export async function waitForOptions(frame, selector, timeoutMs = TIMING.pageReadyTimeoutMs) {
  if (!(await hasSelector(frame, selector))) return true; // 這一頁沒有這個下拉，交給後面的步驟處理
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await frame
      .$eval(selector, (element) => element.options.length)
      .catch(() => 0);
    // 只有「請選擇」一個選項也等同還沒載入。
    if (count > 1) return true;
    await frame.page().waitForTimeout(TIMING.pollIntervalMs);
  }
  return false;
}

/**
 * 填欄位：優先用實跑取得的 id，id 不在就退回用標籤文字找。
 *
 * 為什麼要兩條路：id 精準（這一頁藏了兩整組同名欄位，用標籤會挑到隱藏的那組），
 * 但系統改版時 id 會變，那時還有標籤可以撐著。
 */
async function fillByIdOrLabel(frame, selector, labelCandidates, value) {
  if (await hasSelector(frame, selector)) {
    try {
      await frame.fill(selector, value);
      return { ok: true, selector };
    } catch {
      // 欄位被鎖住或看不見時往下走，改用標籤找。
    }
  }
  return setField(frame, labelCandidates, value, { tag: 'input' });
}

/** 在任一 frame 點下文字相符的元素。 */
async function clickAnywhere(page, textCandidates, options = {}) {
  const found = await onSomeFrame(page, async (frame) => {
    const hits = await findClickables(frame, textCandidates, options);
    if (hits.length === 0) return null;
    const clicked = await clickMatch(frame, textCandidates, options.index ?? 0, options);
    return clicked ? { hits, text: hits[options.index ?? 0]?.text ?? '' } : null;
  });
  return found;
}

/**
 * 目前畫面就是查詢頁嗎（是的話回傳它所在的 frame）。
 *
 * ⚠ **不要試著用網址直接開查詢頁**：`/SSO/subSystemSetForm` 用 GET 開只會得到
 * 一個空白頁（畫面上只有一個時間戳），而且導航過去之後連主畫面都回不去了
 * ——2026-08-18 實跑試過，反而把原本走得通的流程弄壞。這一頁只能從選單進入。
 *
 * @returns {Promise<import('playwright-core').Frame|null>}
 */
async function findQueryPageFrame(session) {
  const found = await onSomeFrame(activePage(session), async (frame) =>
    (await hasSelector(frame, SITE.flow.querySelectors.name)) ? frame : null,
  );
  return found?.value ?? null;
}

/**
 * 回到「選擇子系統」的主畫面。
 *
 * 查詢頁上沒有右上角的「你好」選單，卻有一顆「回到選擇系統」——
 * 處理完一位要再查下一位時，就是靠它回到有選單的地方。
 * 按不到才退回重新開登入網址（那一頁在已登入時就是主畫面）。
 */
async function backToMainMenu(session) {
  const page = activePage(session);
  const clicked = await clickAnywhere(page, SITE.flow.backToMenuTexts);
  if (!clicked) return false;
  await page.waitForTimeout(TIMING.retryIntervalMs);
  return true;
}

/**
 * 步驟 1＋2：右上角「OOO，你好」→「帳號子系統權限」。
 *
 * 兩步合成一個函式是因為它們永遠一起做：每處理完一位，都要從這裡重新開始，
 * 這樣不必猜「上一個人的畫面現在停在哪」。
 *
 * @returns {Promise<{ok: true, frame: import('playwright-core').Frame} | {ok: false, step: string, detail: string, candidates: string[]}>}
 */
export async function openAccountPermissionPage(session) {
  const page = activePage(session);

  // 已經在查詢頁就別再繞一圈：處理第二位以後多半就是這個情況
  // （做完一位還停在同一頁），直接改條件重新搜尋即可。
  const already = await findQueryPageFrame(session);
  if (already) return { ok: true, frame: already };

  // 不在查詢頁也沒有「你好」選單時（例如停在權限畫面），
  // 才點「回到選擇系統」回主畫面。
  //
  // ⚠ 這裡**絕對不能用 goto 回登入網址**：這個系統的主畫面是登入後動態切換出來的，
  //   重新 GET 一律退回登入表單，等於把自己登出（2026-08-18 實跑踩過，
  //   剛登入成功的畫面被自己洗掉，接著就找不到「你好」了）。
  const greeting = await findClickables(page.mainFrame(), SITE.flow.userMenuTexts).catch(() => []);
  if (greeting.length === 0) await backToMainMenu(session);

  const userMenu = await retry(() => clickAnywhere(page, SITE.flow.userMenuTexts), page);
  if (!userMenu) {
    return {
      ok: false,
      step: '步驟1 點右上角的「你好」',
      detail: '畫面上找不到「OOO，你好」那個按鈕（可能還沒登入完成，或系統改了寫法）',
      candidates: await describeScreen(page),
    };
  }
  await page.waitForTimeout(TIMING.retryIntervalMs);

  const menuItem = await retry(() => clickAnywhere(page, SITE.flow.accountMenuTexts), page);
  if (!menuItem) {
    return {
      ok: false,
      step: '步驟2 點「帳號子系統權限」',
      detail: '使用者選單展開了，但裡面找不到「帳號子系統權限」',
      candidates: await describeScreen(page),
    };
  }

  // 等查詢頁真的出現。不等網路閒置（這類系統常有背景請求，永遠等不到閒置），
  // 改以「畫面上出現查詢表單」判定：**姓名欄或搜尋鈕，有一個就算到站**。
  // 只認姓名欄是不夠的——實跑（2026-08-18）發現這個系統的欄位沒有標籤，
  // 認不出姓名欄時整個流程會停在這裡，即使畫面其實已經到了。
  const attempts = Math.ceil(TIMING.pageReadyTimeoutMs / TIMING.pollIntervalMs);
  const queryPage = await retry(
    async () => {
      const current = activePage(session);
      const byField = await onSomeFrame(current, (frame) => findField(frame, SITE.flow.nameLabels, { tag: 'input' }));
      if (byField) return byField;
      return onSomeFrame(current, async (frame) => {
        const hits = await findClickables(frame, SITE.flow.searchTexts);
        return hits.length > 0 ? hits : null;
      });
    },
    page,
    attempts,
    TIMING.pollIntervalMs,
  );
  if (!queryPage) {
    return {
      ok: false,
      step: '步驟2 等查詢畫面出現',
      detail:
        `點了「帳號子系統權限」，但等了 ${Math.round(TIMING.pageReadyTimeoutMs / 1000)} 秒，` +
        '畫面上既找不到「姓名」欄位，也找不到「搜尋」按鈕',
      candidates: await describeFields(activePage(session)),
    };
  }
  return { ok: true, frame: queryPage.frame };
}

/**
 * 步驟 3：填查詢條件（單位、姓名，帳號關鍵字清空）並送出搜尋。
 *
 * 帳號關鍵字**一定要清成空白**——使用者特別交代過：那一欄有殘留值就查不到人。
 */
async function submitSearch(session, frame, entry) {
  const page = activePage(session);
  const selectors = SITE.flow.querySelectors;

  // 單位下拉的選項是**進頁面之後才由伺服器載入的**（實跑探測到當下是 0 個選項），
  // 太早選會什麼都選不到，所以先等它有東西。
  const unitReady = await waitForOptions(frame, selectors.unit);
  if (!unitReady) {
    return {
      ok: false,
      step: '步驟3 等單位清單載入',
      detail: `等了 ${Math.round(TIMING.pageReadyTimeoutMs / 1000)} 秒，單位下拉還是空的（沒有任何選項）`,
      candidates: await describeFields(page),
    };
  }

  // 單位：優先用實跑取得的 id；id 失效（系統改版）時才退回用標籤找。
  const unitSelector = (await hasSelector(frame, selectors.unit))
    ? selectors.unit
    : (await findField(frame, SITE.flow.unitLabels, { tag: 'select' }))?.selector ?? '';
  const unitResult = await selectOptionByText(frame, unitSelector, [entry.unit], SITE.flow.unitLabels);
  if (!unitResult.ok) {
    return {
      ok: false,
      step: '步驟3 選單位',
      detail: `單位「${entry.unit}」${unitResult.reason}`,
      candidates: unitResult.ambiguous?.length
        ? unitResult.ambiguous
        : (await listSelects(frame, { optionLimit: 40 })).flatMap((select) => select.options).slice(0, 40),
    };
  }
  log.info(`  單位：${unitResult.chosen}`);

  const nameResult = await fillByIdOrLabel(frame, selectors.name, SITE.flow.nameLabels, entry.name);
  if (!nameResult.ok) {
    return {
      ok: false,
      step: '步驟3 填姓名',
      detail: '找不到「姓名」欄位',
      candidates: await describeFields(page),
    };
  }

  // 帳號關鍵字清空；這一欄不一定存在（有些畫面沒有），沒有就不算失敗。
  const accountResult = await fillByIdOrLabel(frame, selectors.accountKeyword, SITE.flow.accountKeywordLabels, '');
  log.info(accountResult.ok ? '  帳號關鍵字：已清成空白' : '  帳號關鍵字：這個畫面沒有這一欄，略過');

  const searched = await clickAnywhere(page, SITE.flow.searchTexts);
  if (!searched) {
    return {
      ok: false,
      step: '步驟3 按搜尋',
      detail: '找不到「搜尋」按鈕',
      candidates: await describeScreen(page),
    };
  }
  await page.waitForTimeout(TIMING.querySettleMs);
  return { ok: true };
}

/**
 * 步驟 4：確認查詢結果只有一個人。
 *
 * 用「那一列的『設定』按鈕有幾個」來數人數，而不是數表格列數——
 * 查詢條件區本身也是表格，數列數會把它一起算進去。
 */
async function countMatchedPeople(session) {
  const page = activePage(session);

  // 先等表格載完：還在「載入中」時讀到的是上一次查詢的結果。
  await waitWhileLoading(page);

  // 系統自己會寫「顯示第 1 至 10 項結果，共 N 項」——優先讀這個。
  // 數畫面上的「設定」按鈕會被分頁誤導：一頁只顯示 10 筆，
  // 查到 26 個人也只會看到 10 個按鈕，那就變成「以為只有 10 個」。
  for (const frame of page.frames()) {
    const text = await matchText(frame, SITE.resultCountPattern).catch(() => '');
    if (text) {
      const total = Number.parseInt(text.replace(/,/g, ''), 10);
      if (Number.isFinite(total)) return { total, countedBy: '系統顯示的筆數' };
    }
  }

  // 讀不到筆數文字（系統改版）時，退回數按鈕。
  let total = 0;
  for (const frame of page.frames()) {
    const hits = await findClickables(frame, SITE.flow.rowActionTexts, { exact: true }).catch(() => []);
    total += hits.length;
  }
  return { total, countedBy: '畫面上的設定按鈕數' };
}

/** 等畫面上的「載入中」消失（等不到就算了，後面的判斷自己會擋）。 */
async function waitWhileLoading(page, timeoutMs = TIMING.pageReadyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let loading = '';
    for (const frame of page.frames()) {
      loading = await hasText(frame, SITE.loadingMarkers).catch(() => '');
      if (loading) break;
    }
    if (!loading) return true;
    await page.waitForTimeout(TIMING.pollIntervalMs);
  }
  return false;
}

/**
 * 步驟 6：在權限畫面把「MCI大量傷病患救護管理系統」設成「MCI002 縣市端使用者」。
 *
 * 這個系統的版面還沒探測過，因此兩種常見寫法都試：
 *   1. 子系統那一列旁邊就是一個下拉 → 直接選
 *   2. 旁邊是一顆按鈕，按了才跳出角色清單 → 按下去再點 MCI002
 */
async function chooseRole(session) {
  const page = activePage(session);
  const code = SITE.flow.subsystemCode;
  const rowTexts = [SITE.flow.subsystemText, ...SITE.flow.subsystemHints];
  const roleTexts = [SITE.flow.roleText, ...SITE.flow.roleHints];

  // 寫法 0（實跑確認的正解）：每個子系統的角色下拉 id 就是「代碼＋select」，
  // 勾選框 id 就是代碼本身。**這一頁一定要用 id**——畫面上的子系統名稱與下拉
  // 是錯開的（`#ACSselect` 旁邊寫的是「MCI 大量傷病患救護管理系統」），
  // 用文字定位會設到隔壁那個子系統去。
  const byId = await retry(
    () =>
      onSomeFrame(activePage(session), async (frame) => {
        const roleSelector = `#${code}select`;
        if (!(await hasSelector(frame, roleSelector))) return null;
        const result = await selectOptionByText(frame, roleSelector, roleTexts);
        return result.ok ? { result, frame } : null;
      }),
    page,
    3,
    800,
  );
  if (byId) {
    const { result, frame } = byId.value;
    log.info(`  角色：${result.chosen}（${code}select）`);
    const checkbox = await ensureSubsystemChecked(frame, code);
    return { ok: true, chosen: result.chosen, checkbox };
  }

  // 寫法 1：那一列就有下拉（id 變了時的後備）。
  const inRow = await retry(
    () => onSomeFrame(activePage(session), async (frame) => {
      const result = await selectOptionInRow(frame, rowTexts, roleTexts);
      return result.ok ? result : null;
    }),
    page,
    3,
    800,
  );
  if (inRow) {
    log.info(`  角色：${inRow.value.chosen}`);
    return { ok: true, chosen: inRow.value.chosen };
  }

  // 寫法 2：先按那一列的按鈕，再從跳出來的清單點角色。
  const buttonClicked = await onSomeFrame(activePage(session), async (frame) => {
    const result = await rowAction(frame, { rowTexts, actionTexts: [] });
    return result.ok ? result : null;
  });
  if (buttonClicked) {
    await page.waitForTimeout(TIMING.retryIntervalMs);
    const roleClicked = await retry(() => clickAnywhere(activePage(session), roleTexts), page, 3, 800);
    if (roleClicked) {
      log.info(`  角色：${roleClicked.value.text}`);
      return { ok: true, chosen: roleClicked.value.text };
    }
  }

  const selects = [];
  for (const frame of activePage(session).frames()) {
    const found = await listSelects(frame, { optionLimit: 30 }).catch(() => []);
    for (const select of found) selects.push(...select.options);
  }
  return {
    ok: false,
    step: '步驟6 選 MCI002 縣市端使用者',
    detail: `找不到「${SITE.flow.subsystemText}」旁邊可以選角色的地方`,
    candidates: selects.length ? selects.slice(0, 40) : await describeScreen(activePage(session)),
  };
}

/**
 * 確認子系統的勾選框是勾起來的（開通就是要勾）。
 *
 * **只在沒勾的時候才勾**：有些頁面選了角色會自動把勾選框打勾，
 * 這時再點一次等於取消勾選——那會變成「選了角色卻沒開通」，
 * 畫面上還看起來好像做完了。
 *
 * @returns {Promise<string>} 給人看的狀態說明
 */
async function ensureSubsystemChecked(frame, code) {
  const selector = `#${code}`;
  if (!(await hasSelector(frame, selector))) return '沒有勾選框';
  const checked = await frame.isChecked(selector).catch(() => null);
  if (checked === null) return '勾選框讀不到狀態';
  if (checked) return '勾選框本來就已勾選';
  const done = await frame
    .check(selector)
    .then(() => true)
    .catch(() => false);
  return done ? '已補勾選框' : '勾選框點不動';
}

/**
 * 處理一位人員（六個步驟走完）。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {import('./roster.mjs').RosterEntry} entry
 * @param {{execute?: boolean}} [options] `execute` 為真才會真的按下「確定」
 * @returns {Promise<GrantResult>}
 */
export async function grantOne(session, entry, options = {}) {
  const base = { unit: entry.unit, name: entry.name };

  const opened = await openAccountPermissionPage(session);
  if (!opened.ok) return { ...base, outcome: OUTCOME.failed, ...opened };

  const searched = await submitSearch(session, opened.frame, entry);
  if (!searched.ok) return { ...base, outcome: OUTCOME.failed, ...searched };

  const { total, countedBy } = await countMatchedPeople(session);
  log.info(`  查詢結果：${total} 筆（依${countedBy}）`);
  if (total === 0) {
    const message = await hasText(activePage(session).mainFrame(), SITE.errorMarkers).catch(() => '');
    return {
      ...base,
      outcome: OUTCOME.notFound,
      step: '步驟4 看查詢結果',
      detail: message
        ? `查詢結果 0 筆（畫面訊息：${message}）`
        : '查詢結果 0 筆——單位或姓名可能與系統裡的寫法不同',
    };
  }
  if (total > 1) {
    return {
      ...base,
      outcome: OUTCOME.multiple,
      step: '步驟4 看查詢結果',
      detail: `查到 ${total} 個人（依${countedBy}），無法確定是哪一位，這一筆跳過不處理（請自行到系統確認）`,
    };
  }

  const settingClicked = await clickAnywhere(activePage(session), SITE.flow.rowActionTexts, { exact: true });
  if (!settingClicked) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '步驟5 點那一列的「設定」',
      detail: '查到一個人，但按不到「設定」',
      candidates: await describeScreen(activePage(session)),
    };
  }
  await activePage(session).waitForTimeout(TIMING.retryIntervalMs);

  const role = await chooseRole(session);
  if (!role.ok) return { ...base, outcome: OUTCOME.failed, ...role };

  if (!options.execute) {
    return {
      ...base,
      outcome: OUTCOME.dryRun,
      step: '步驟6 已選好角色，停在「確定」之前',
      detail:
        `已選「${role.chosen}」${role.checkbox ? `（${role.checkbox}）` : ''}` +
        '但沒有按確定（試跑）。確認無誤後加上 --execute 才會真的開通',
    };
  }

  const confirmed = await clickAnywhere(activePage(session), SITE.flow.confirmTexts);
  if (!confirmed) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '步驟6 按確定',
      detail: '角色已選好，但找不到「確定」按鈕（權限沒有存進去）',
      candidates: await describeScreen(activePage(session)),
    };
  }
  await activePage(session).waitForTimeout(TIMING.querySettleMs);

  const errorText = await hasText(activePage(session).mainFrame(), SITE.errorMarkers).catch(() => '');
  if (errorText) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '步驟6 按確定之後',
      detail: `按了確定，但畫面出現訊息：${errorText}`,
    };
  }
  return {
    ...base,
    outcome: OUTCOME.granted,
    step: '完成',
    detail: `已設定「${role.chosen}」${role.checkbox ? `（${role.checkbox}）` : ''}並按下確定`,
  };
}

/**
 * 依名單逐一處理。
 *
 * 一位失敗不影響其他人：結果全部收下來，最後一起列出，
 * 這樣使用者跑一次就知道哪些人要自己補做，不必盯著看。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {import('./roster.mjs').RosterEntry[]} entries
 * @param {{execute?: boolean}} [options]
 * @returns {Promise<GrantResult[]>}
 */
export async function grantAll(session, entries, options = {}) {
  /** @type {GrantResult[]} */
  const results = [];
  for (const [index, entry] of entries.entries()) {
    log.step(`[${index + 1}/${entries.length}] ${entry.unit}　${maskName(entry.name)}`);
    let result;
    try {
      result = await grantOne(session, entry, options);
    } catch (error) {
      result = {
        unit: entry.unit,
        name: entry.name,
        outcome: OUTCOME.failed,
        step: '未預期的錯誤',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    const line = `${result.outcome}｜${result.detail}`;
    if (result.outcome === OUTCOME.granted || result.outcome === OUTCOME.dryRun) log.ok(line);
    else log.warn(line);
    if (result.candidates?.length) {
      log.info(`  畫面上看得到的：${result.candidates.slice(0, 15).join('、')}`);
    }
    // 不要打得比人快太多：連續操作太密集容易被系統當成攻擊而擋下來。
    if (index < entries.length - 1) await activePage(session).waitForTimeout(TIMING.betweenPeopleMs);
  }
  return results;
}
