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
  readSubsystemDom,
  setVisibleCheckbox,
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
  /** 本來就已經是 MCI002 了，什麼都不用做。 */
  alreadyGranted: '本來就有了',
  /** 撤銷：已經把勾選取消掉了。 */
  revoked: '已取消',
  /** 撤銷：本來就沒有勾，不用動。 */
  alreadyRevoked: '本來就沒有',
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
export async function backToMainMenu(session) {
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

  // 回讀實際填進去的值：查不到人時，這一行就分得出是「真的沒這個人」
  // 還是「條件根本沒填進去」（姓名一律遮蔽）。
  await logAppliedConditions(frame, selectors);

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

/** 把「畫面上現在真正填著什麼」寫進紀錄（姓名遮蔽）。 */
async function logAppliedConditions(frame, selectors) {
  const readValue = async (selector) =>
    frame
      .$eval(selector, (element) => {
        if (element.tagName.toLowerCase() === 'select') {
          const chosen = element.selectedOptions[0];
          return chosen ? chosen.textContent.replace(/\s+/g, ' ').trim() : '';
        }
        return element.value;
      })
      .catch(() => '(讀不到)');

  const unit = await readValue(selectors.unit);
  const name = await readValue(selectors.name);
  const account = await readValue(selectors.accountKeyword);
  log.info(
    `  送出的條件：單位「${unit}」／姓名「${maskName(name)}」／帳號關鍵字「${account || '(空白)'}」`,
  );
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
  //
  // ⚠ 但**不能讀了就算**：這個數字在表格重新載入時會先變成 0 再跳到正確值。
  // 2026-08-20 實際踩到——同樣的查詢條件，前一次讀到 1 筆、後一次讀到「0 筆」
  // 而畫面上明明有資料，於是回報「查無此人」。所以要等它穩定下來。
  const stable = await readStableCount(page);
  if (stable !== null) return { total: stable, countedBy: '系統顯示的筆數' };

  // 讀不到筆數文字（系統改版）時，退回數按鈕。
  let total = 0;
  for (const frame of page.frames()) {
    const hits = await findClickables(frame, SITE.flow.rowActionTexts, { exact: true }).catch(() => []);
    total += hits.length;
  }
  return { total, countedBy: '畫面上的設定按鈕數' };
}

/**
 * 讀出「共 N 項」，並等它**連續幾次都一樣**才採信。
 *
 * 為什麼要等穩定：這個數字在表格重新載入時會先掉成 0 再跳到正確值。
 * 只讀一次的話，剛好讀到中間態就會把「有這個人」判成「查無此人」，
 * 而那會讓一位同仁的權限被默默漏掉（2026-08-20 實際發生過）。
 *
 * @returns {Promise<number|null>} 讀不到筆數文字時回傳 null（呼叫端改用數按鈕）
 */
export async function readStableCount(page, timeoutMs = TIMING.pageReadyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let sameSince = 0;

  while (Date.now() < deadline) {
    let current = null;
    for (const frame of page.frames()) {
      const text = await matchText(frame, SITE.resultCountPattern).catch(() => '');
      if (!text) continue;
      const parsed = Number.parseInt(text.replace(/,/g, ''), 10);
      if (Number.isFinite(parsed)) {
        current = parsed;
        break;
      }
    }
    if (current === null) return null; // 這一頁沒有筆數文字（系統改版）

    if (current === previous) {
      if (Date.now() - sameSince >= TIMING.countStableMs) return current;
    } else {
      previous = current;
      sameSince = Date.now();
    }
    await page.waitForTimeout(TIMING.pollIntervalMs / 2);
  }
  return previous; // 等不到完全穩定就用最後看到的值，總比沒有好
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

        // **先看原本是什麼**，再動手。順序反過來的話，選完就再也答不出
        // 「這個人本來有沒有權限」——而那正是承辦人看名單時最想知道的一件事。
        const before = await readSubsystemState(frame, code);
        if (before.alreadyGranted) return { frame, before, alreadyGranted: true };

        const result = await selectOptionByText(frame, roleSelector, roleTexts);
        return result.ok ? { result, frame, before } : null;
      }),
    page,
    3,
    800,
  );
  if (byId) {
    const { result, frame, before, alreadyGranted } = byId.value;
    if (alreadyGranted) {
      log.info(`  這個人本來就有「${before.role}」，不動它`);
      return { ok: true, chosen: before.role, alreadyGranted: true, before };
    }
    log.info(`  角色：${result.chosen}（${code}select，原本是「${before.role || '沒有選'}」）`);
    const checkbox = await ensureSubsystemChecked(frame, code);
    return { ok: true, chosen: result.chosen, checkbox, before };
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
    // skipToggles：這一列的第一個可按元素其實是勾選框，點下去會把
    // 已經勾好的權限取消掉（2026-08-18 由測試抓到）。
    const result = await rowAction(frame, { rowTexts, actionTexts: [], skipToggles: true });
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
 * 讀出這個子系統**目前**的權限狀態（動手之前的樣子）。
 *
 * @returns {Promise<{checked:boolean, role:string, alreadyGranted:boolean}>}
 *   `alreadyGranted`＝勾選框已勾、而且角色就是我們要設的那一個
 */
export async function readSubsystemState(frame, code) {
  const dom = await readSubsystemDom(frame, `#${code}`, `#${code}select`).catch(() => null);
  if (!dom) return { checked: false, role: '', alreadyGranted: false, duplicated: false };

  const role = dom.role.text;
  const checked = dom.checkbox.checked === true;
  const wanted = [SITE.flow.roleText, ...SITE.flow.roleHints];
  const squeeze = (text) => String(text ?? '').replace(/[\s　]/g, '');
  const roleMatches = wanted.some((candidate) => squeeze(role).includes(squeeze(candidate)));

  // 同一個 id 出現不只一次，代表這一頁藏了好幾組表單——
  // 這正是 2026-08-20 那次「選了卻沒存進去」的原因，值得寫進紀錄。
  const duplicated = dom.checkbox.total > 1 || dom.role.total > 1;
  if (duplicated) {
    log.info(
      `  注意：#${code} 在這一頁有 ${dom.checkbox.total} 個（看得見 ${dom.checkbox.visibleCount} 個）、` +
        `#${code}select 有 ${dom.role.total} 個（看得見 ${dom.role.visibleCount} 個）`,
    );
  }
  return { checked, role, alreadyGranted: checked && roleMatches, duplicated, dom };
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
  const result = await setVisibleCheckbox(frame, `#${code}`, true).catch(() => null);
  if (!result) return '勾選框讀不到狀態';
  if (!result.ok) return result.reason;
  return result.checked ? '勾選框已勾起來' : '勾選框點了仍未勾起來';
}

/**
 * 步驟 1～5：進查詢頁 → 查這個人 → 確認只有一位 → 點「設定」。
 *
 * 開通與**回讀驗證**都要走這一段，因此抽出來共用：
 * 驗證時若走另一份實作，兩邊對「查到幾個人」的判斷可能不一致，
 * 那會讓驗證結果變得不可信。
 *
 * @returns {Promise<{ok: true, frame: import('playwright-core').Frame}
 *   | {ok: false, result: object, detail: string}>}
 */
async function locatePerson(session, entry) {
  const fail = (result) => ({ ok: false, result, detail: result.detail });

  const opened = await openAccountPermissionPage(session);
  if (!opened.ok) return fail({ outcome: OUTCOME.failed, ...opened });

  const searched = await submitSearch(session, opened.frame, entry);
  if (!searched.ok) return fail({ outcome: OUTCOME.failed, ...searched });

  const { total, countedBy } = await countMatchedPeople(session);
  log.info(`  查詢結果：${total} 筆（依${countedBy}）`);
  if (total === 0) {
    const message = await hasText(activePage(session).mainFrame(), SITE.errorMarkers).catch(() => '');
    return fail({
      outcome: OUTCOME.notFound,
      step: '步驟4 看查詢結果',
      detail: message
        ? `查詢結果 0 筆（畫面訊息：${message}）`
        : '查詢結果 0 筆——單位或姓名可能與系統裡的寫法不同',
    });
  }
  if (total > 1) {
    return fail({
      outcome: OUTCOME.multiple,
      step: '步驟4 看查詢結果',
      detail: `查到 ${total} 個人（依${countedBy}），無法確定是哪一位，這一筆跳過不處理（請自行到系統確認）`,
    });
  }

  const settingClicked = await clickAnywhere(activePage(session), SITE.flow.rowActionTexts, { exact: true });
  if (!settingClicked) {
    return fail({
      outcome: OUTCOME.failed,
      step: '步驟5 點那一列的「設定」',
      detail: '查到一個人，但按不到「設定」',
      candidates: await describeScreen(activePage(session)),
    });
  }
  await activePage(session).waitForTimeout(TIMING.retryIntervalMs);

  const frame = (await findQueryPageFrame(session)) ?? activePage(session).mainFrame();
  return { ok: true, frame };
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

  const located = await locatePerson(session, entry);
  if (!located.ok) return { ...base, ...located.result };

  const role = await chooseRole(session);
  if (!role.ok) return { ...base, outcome: OUTCOME.failed, ...role };

  if (role.alreadyGranted) {
    return {
      ...base,
      outcome: OUTCOME.alreadyGranted,
      step: '步驟6 檢查現況',
      detail: `這個人本來就有「${role.chosen}」，沒有動任何東西`,
    };
  }

  if (!options.execute) {
    return {
      ...base,
      outcome: OUTCOME.dryRun,
      step: '步驟6 已選好角色，停在「確定」之前',
      detail:
        `已選「${role.chosen}」${role.checkbox ? `（${role.checkbox}）` : ''}` +
        `${role.before?.role ? `，原本是「${role.before.role}」` : ''}` +
        '，但沒有按確定（試跑）。確認無誤後加上 --execute 才會真的開通',
    };
  }

  const confirmed = await pressConfirm(session);
  if (!confirmed.ok) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '步驟6 按確定',
      detail: '角色已選好，但一顆送出的按鈕都按不到（權限沒有存進去）',
      candidates: await describeScreen(activePage(session)),
    };
  }
  log.info(`  按下：${confirmed.pressed.join(' → ')}`);
  if (!confirmed.savedPressed) {
    // 實測這一頁只有一顆送出鍵（文字就是「確定」）。這裡不預先斷言成敗——
    // 有沒有真的存進去，一律以下面的回讀查證為準。
    log.info('  這個畫面只有一顆送出鍵；是否真的存進去以回頭查證為準');
  }

  const errorText = await hasText(activePage(session).mainFrame(), SITE.errorMarkers).catch(() => '');
  if (errorText) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '步驟6 按確定之後',
      detail: `按了確定，但畫面出現訊息：${errorText}`,
    };
  }

  const done =
    `已設定「${role.chosen}」${role.checkbox ? `（${role.checkbox}）` : ''}` +
    `${role.before?.role ? `，原本是「${role.before.role}」` : ''}` +
    `並依序按下「${confirmed.pressed.join('」→「')}」` +
    `${confirmed.dialogMessage ? `（系統確認視窗：「${confirmed.dialogMessage}」）` : ''}`;

  if (options.verify === false) {
    return { ...base, outcome: OUTCOME.granted, step: '完成（未回讀驗證）', detail: done };
  }

  // 按了按鈕不等於存進去了。**回頭再查一次**才算數——
  // 這一步是 2026-08-20 補的：那次回報「已開通」，但確認視窗被自動按掉，
  // 實際上什麼都沒存（見 TOOLS_SPEC 6.17）。
  const verified = await verifyGranted(session, entry);
  if (verified.ok) {
    return { ...base, outcome: OUTCOME.granted, step: '完成（已回讀確認）', detail: `${done}；回頭查證：${verified.detail}` };
  }
  return {
    ...base,
    outcome: OUTCOME.failed,
    step: '步驟7 回讀驗證',
    detail: `${done}，但回頭查證發現${verified.detail}——請自己到系統確認`,
  };
}

/**
 * 按下「確定」，並**接手系統跳出的確認視窗**。
 *
 * ⚠ Playwright 預設會把瀏覽器的 confirm／alert **自動按取消**。
 * 不自己接手的話，畫面看起來按了確定、程式也回報成功，
 * 實際上什麼都沒存（救護系統那邊 2026-08-05 踩過同一個坑，見 `unlock.mjs`）。
 *
 * @returns {Promise<{ok: boolean, dialogMessage: string}>}
 */
export async function pressConfirm(session) {
  const page = activePage(session);
  let dialogMessage = '';
  const onDialog = async (dialog) => {
    // 訊息可能帶姓名或帳號，只留前 80 字並遮蔽長數字。
    dialogMessage = dialog.message().replace(/\d{5,}/g, '#####').replace(/\s+/g, ' ').trim().slice(0, 80);
    log.info(`  系統跳出確認視窗：「${dialogMessage}」→ 按下確定`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);

  const pressed = [];
  try {
    // 第一顆：權限視窗裡的「確定」（把選擇套用到畫面）。
    const inDialog = await clickAnywhere(page, SITE.flow.confirmTexts, { exact: true });
    if (inDialog) {
      pressed.push(inDialog.value.text);
      await page.waitForTimeout(TIMING.querySettleMs);
    }

    // 第二顆：某些畫面在權限視窗之外還有一顆送出鍵。
    // **實測這一頁沒有**（送出鍵就是上面那顆「確定」），所以只找一次就好，
    // 找不到不是問題——真正的成敗由後面的回讀查證決定。
    const finalConfirm = await clickAnywhere(activePage(session), SITE.flow.finalConfirmTexts, { exact: true });
    if (finalConfirm) {
      pressed.push(finalConfirm.value.text);
      await activePage(session).waitForTimeout(TIMING.querySettleMs);
    }
  } finally {
    page.off('dialog', onDialog);
  }

  if (pressed.length === 0) return { ok: false, dialogMessage, pressed };
  // 只按到第一顆就等於沒存，講明白，別讓人以為做完了。
  const savedPressed = pressed.some((text) =>
    SITE.flow.finalConfirmTexts.some((candidate) => text.replace(/\s/g, '') === candidate),
  );
  return { ok: true, dialogMessage, pressed, savedPressed };
}

/**
 * 回讀驗證：重新查一次這個人，看權限是不是真的變成 MCI002。
 *
 * 慢一點沒關係——「以為開好了其實沒有」比多花十秒嚴重得多。
 * 不想等的話可以用 `--no-verify` 關掉。
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function verifyGranted(session, entry) {
  const located = await locatePerson(session, entry);
  if (!located.ok) return { ok: false, detail: `查不回這個人（${located.detail}）` };

  const state = await readSubsystemState(located.frame, SITE.flow.subsystemCode).catch(() => null);
  if (!state) return { ok: false, detail: '讀不到權限現況' };
  if (state.alreadyGranted) return { ok: true, detail: `確實是「${state.role}」` };
  return {
    ok: false,
    detail: `權限仍是「${state.role || '沒有選'}」${state.checked ? '' : '、而且勾選框沒有勾起來'}（沒有存進去）`,
  };
}

/**
 * 取消一位人員的 MCI 權限：把子系統前面的勾選**取消**，再按確定。
 *
 * ⚠ 這是把權限**拿掉**，比開通更該小心，因此：
 *   - 只動勾選框，不去改角色下拉（使用者 2026-08-21 指定的作法）
 *   - **本來就沒勾的一律不碰**——那些多半是「本來就沒有權限」的人
 *   - 按完確定一樣**回頭查一次**，確認真的取消掉了才回報成功
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {import('./roster.mjs').RosterEntry} entry
 * @param {{execute?: boolean, verify?: boolean}} [options]
 * @returns {Promise<GrantResult>}
 */
export async function revokeOne(session, entry, options = {}) {
  const base = { unit: entry.unit, name: entry.name };
  const code = SITE.flow.subsystemCode;

  const located = await locatePerson(session, entry);
  if (!located.ok) return { ...base, ...located.result };

  const before = await readSubsystemState(located.frame, code);
  if (!before.checked) {
    return {
      ...base,
      outcome: OUTCOME.alreadyRevoked,
      step: '檢查現況',
      detail: `現在就沒有勾選 ${code}（角色顯示「${before.role || '沒有選'}」），沒有動它`,
    };
  }
  log.info(`  目前：已勾選、角色「${before.role || '沒有選'}」→ 取消勾選`);

  if (!options.execute) {
    return {
      ...base,
      outcome: OUTCOME.dryRun,
      step: '停在取消之前',
      detail: `目前已勾選（角色「${before.role || '沒有選'}」）；試跑不會取消，加 --execute 才會`,
    };
  }

  const unchecked = await setVisibleCheckbox(located.frame, `#${code}`, false).catch(() => null);
  if (!unchecked?.ok || unchecked.checked) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '取消勾選',
      detail: unchecked?.reason ?? '勾選框點不動，權限沒有被取消',
    };
  }

  const confirmed = await pressConfirm(session);
  if (!confirmed.ok) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '按確定',
      detail: '勾選已取消，但一顆送出的按鈕都按不到（等於沒有取消）',
      candidates: await describeScreen(activePage(session)),
    };
  }
  log.info(`  按下：${confirmed.pressed.join(' → ')}`);

  const done = `已取消勾選（原本是「${before.role || '沒有選'}」）並按下「${confirmed.pressed.join('」→「')}」`;
  if (options.verify === false) {
    return { ...base, outcome: OUTCOME.revoked, step: '完成（未回讀驗證）', detail: done };
  }

  // 一樣回頭查一次：按了按鈕不等於真的存進去（見 TOOLS_SPEC 6.16）。
  const again = await locatePerson(session, entry);
  if (!again.ok) {
    return {
      ...base,
      outcome: OUTCOME.failed,
      step: '回讀驗證',
      detail: `${done}，但回頭查不回這個人（${again.detail}）——請自己到系統確認`,
    };
  }
  const after = await readSubsystemState(again.frame, code);
  if (!after.checked) {
    return { ...base, outcome: OUTCOME.revoked, step: '完成（已回讀確認）', detail: `${done}；回頭查證：確實已取消勾選` };
  }
  return {
    ...base,
    outcome: OUTCOME.failed,
    step: '回讀驗證',
    detail: `${done}，但回頭查證發現仍然勾著（角色「${after.role}」，沒有取消成功）——請自己到系統確認`,
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
  return runBatch(session, entries, options, grantOne);
}

/**
 * 依名單逐一**取消**權限。
 * @param {import('./session.mjs').PermSession} session
 * @param {import('./roster.mjs').RosterEntry[]} entries
 * @param {{execute?: boolean, verify?: boolean}} [options]
 * @returns {Promise<GrantResult[]>}
 */
export async function revokeAll(session, entries, options = {}) {
  return runBatch(session, entries, options, revokeOne);
}

/**
 * 逐一處理一整批人（開通與撤銷共用同一個迴圈）。
 *
 * 一位失敗不影響其他人：結果全部收下來，最後一起列出，
 * 這樣使用者跑一次就知道哪些人要自己補做，不必盯著看。
 *
 * @param {(session: object, entry: object, options: object) => Promise<GrantResult>} handleOne
 */
async function runBatch(session, entries, options, handleOne) {
  /** @type {GrantResult[]} */
  const results = [];
  const startedAt = Date.now();
  /** 上一位是不是失敗了（失敗後才值得多花一次登入檢查）。 */
  let lastFailed = false;

  for (const [index, entry] of entries.entries()) {
    log.step(`[${index + 1}/${entries.length}] ${entry.unit}　${maskName(entry.name)}`);

    // 名單很長時登入可能被踢。**不必每一位都檢查**——持續操作本來就不容易被踢，
    // 而每次檢查都要掃一遍畫面。只在「剛失敗過」或每 20 位時確認一次就夠。
    if (options.ensureSignedIn && (lastFailed || index % 20 === 0)) {
      const state = await options.ensureSignedIn();
      if (state === '等不到') {
        const pending = entries.length - index;
        log.warn(`還沒重新登入，剩下的 ${pending} 位先停在這裡（進度已保存，下次接著跑）`);
        break;
      }
    }

    let result;
    try {
      result = await handleOne(session, entry, options);
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

    const succeeded = SETTLED_OUTCOMES.includes(result.outcome);
    lastFailed = !succeeded;

    // 做完一位就記一次：中途關掉視窗，前面做完的才不會白跑。
    if (options.onProgress) {
      await options.onProgress(entry, result).catch((error) => {
        log.warn(`進度沒記起來（不影響已完成的設定）：${error instanceof Error ? error.message : error}`);
      });
    }

    const line = `${result.outcome}｜${result.detail}`;
    if (succeeded) log.ok(line);
    else log.warn(line);
    if (result.candidates?.length) {
      log.info(`  畫面上看得到的：${result.candidates.slice(0, 15).join('、')}`);
    }

    reportProgress(results, index + 1, entries.length, startedAt);

    // 不要打得比人快太多：連續操作太密集容易被系統當成攻擊而擋下來。
    if (index < entries.length - 1) await activePage(session).waitForTimeout(TIMING.betweenPeopleMs);
  }
  return results;
}

/** 「這一位已經處理完，不必再試」的結果。 */
export const SETTLED_OUTCOMES = [
  OUTCOME.granted,
  OUTCOME.dryRun,
  OUTCOME.alreadyGranted,
  OUTCOME.revoked,
  OUTCOME.alreadyRevoked,
];

/** 把毫秒說成人話。 */
function describeDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '不到 1 分鐘';
  if (minutes < 60) return `${minutes} 分鐘`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
}

/**
 * 印一行進度：跑到哪、成績如何、還要多久。
 *
 * 名單長達 1890 位時，「還要多久」是使用者最需要的一個數字
 * ——他得決定今天是要顧著跑完，還是先關掉明天接著跑。
 */
function reportProgress(results, done, total, startedAt) {
  const counts = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  const troubled = results.filter((result) => !SETTLED_OUTCOMES.includes(result.outcome)).length;

  const elapsed = Date.now() - startedAt;
  const remaining = done > 0 ? Math.round((elapsed / done) * (total - done)) : 0;
  const percent = Math.round((done / total) * 100);
  log.info(
    `  ── 進度 ${done}/${total}（${percent}%）｜` +
      `已跑 ${describeDuration(elapsed)}｜預估還要 ${describeDuration(remaining)}｜` +
      `要接手的 ${troubled} 位`,
  );
}
