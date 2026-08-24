/**
 * 頁面定位邏輯的 DOM 測試：用**自己造的假頁面**，在真的瀏覽器裡驗證
 * `domFind.mjs` 找不找得到東西。
 *
 * 為什麼需要這一組：`queryPage` 的程式碼是送進瀏覽器執行的，一般單元測試碰不到；
 * 而它一旦找錯欄位，畫面看起來完全正常，卻可能**幫錯的人開權限**。
 * 目標系統是正式環境，不能拿來反覆試，因此改為造一張版面特徵相同的假頁面來測。
 *
 * ⚠ 假頁面裡沒有任何真實資料，單位、姓名、帳號全是為了測試而編的。
 * ⚠ 本機沒有 Chrome／Edge 時整組自動略過，不讓其他測試跟著失敗。
 *
 * 執行：npm run tool:mci:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BROWSER, SITE } from './config.mjs';
import {
  clickMatch,
  countDataRows,
  findClickables,
  findField,
  findLoginFields,
  hasText,
  listClickableTexts,
  listFields,
  listOptions,
  listSelects,
  readResultColumn,
  rowAction,
  selectOptionByText,
  selectOptionInRow,
  setField,
  readSubsystemDom,
  setVisibleCheckbox,
} from './domFind.mjs';
import { readSubsystemState } from './grantFlow.mjs';

/**
 * 仿照這類政府系統的查詢頁：老式表格排版、標籤寫在隔壁儲存格、
 * 另外故意放了幾個容易誤中的誘餌（「帳號」vs「帳號關鍵字」、相似的單位名稱）。
 */
const QUERY_FIXTURE = `
<div id="header">
  <span id="userMenu">測試員，你好</span>
  <ul id="menu" style="display:none"><li>個人資料維護</li><li>帳號子系統權限</li><li>登出</li></ul>
</div>
<table id="cond">
  <tr>
    <td>單位</td>
    <td>
      <select id="selUnit">
        <option value="">請選擇</option>
        <option value="1">測試甲分隊</option>
        <option value="2">測試乙分隊</option>
        <option value="3">測試乙分隊第二救護隊</option>
      </select>
    </td>
    <td>姓名</td><td><input type="text" id="txtName"></td>
  </tr>
  <tr>
    <!-- 誘餌：「帳號」與「帳號關鍵字」只差三個字，用包含比對會抓錯 -->
    <td>帳號</td><td><input type="text" id="txtAccount" value="不該被動到"></td>
    <td>帳號關鍵字</td><td><input type="text" id="txtAccountKeyword" value="殘留值"></td>
  </tr>
  <tr><td colspan="4"><input type="button" id="btnSearch" value="搜尋"></td></tr>
</table>
<table id="result">
  <tr><th>帳號</th><th>姓名</th><th>單位</th><th>功能</th></tr>
  <tr>
    <td>test0912345678</td><td>測試甲</td><td>測試甲分隊</td>
    <td><input type="button" value="設定"></td>
  </tr>
</table>`;

/**
 * 仿照「查一整個單位」的結果畫面（全面取消要靠它掃出誰在這個單位）：
 * 查詢條件區用真實的 id、結果表格有好幾列人、下面還有分頁按鈕。
 *
 * ⚠ 誘餌一：查詢條件區也是一張表格，第一列就寫著「單位　姓名」——
 *   只認「標題列有姓名」的話會讀到它。
 * ⚠ 誘餌二：分頁同時有「上一頁」與「下一頁」，用包含比對會按錯。
 */
const UNIT_LIST_FIXTURE = `
<table id="cond">
  <tr>
    <td>單位</td>
    <td>
      <select id="searchDeptNotNfa">
        <option value="">請選擇</option>
        <option value="A1">緊急救護科</option>
        <option value="B1">測試甲分隊</option>
      </select>
    </td>
    <td>姓名</td><td><input type="text" id="searchNameNotNfa"></td>
  </tr>
  <tr><td colspan="4"><input type="button" value="搜尋"></td></tr>
</table>
<div>顯示第 1 至 3 項結果，共 3 項</div>
<table id="result">
  <tr><th>帳號</th><th>姓名</th><th>單位</th><th>功能</th></tr>
  <tr><td>test01</td><td>測試甲</td><td>測試甲分隊</td><td><input type="button" value="設定"></td></tr>
  <tr><td>test02</td><td>測試乙</td><td>測試甲分隊</td><td><input type="button" value="設定"></td></tr>
  <tr><td>test03</td><td>測試丙</td><td>測試甲分隊</td><td><input type="button" value="設定"></td></tr>
</table>
<div id="pager"><a href="#">上一頁</a><a href="#">下一頁</a></div>`;

/**
 * 仿照**姓名被遮蔽**的查詢結果（2026-08-23 實跑才發現的真實樣子）。
 *
 * 誘餌有三個，都是 2026-08 實跑真的踩到的：
 *   1. 每一列前面都有一個勾選框（沒有文字，預設規則會讓它排在「設定」前面）；
 *   2. 兩位遮蔽後同名的人（`林O華`）——只看姓名連人也分不出是誰，
 *      但**帳號不一樣**，所以「姓名＋帳號」還是認得出來；
 *   3. 兩個字的名字遮成 `陳O`，而同一頁還有 `陳O宏`——
 *      用「整列文字包含」比對會兩列全中（2026-08-24 卡住的就是這一種）。
 */
const MASKED_LIST_FIXTURE = `
<table id="result">
  <tr><th></th><th>帳號</th><th>姓名</th><th>單位</th><th>功能</th></tr>
  <tr>
    <td><input type="checkbox" id="pick1"></td><td>test01</td><td>許O軒</td><td>特搜大隊</td>
    <td><input type="button" value="設定" onclick="document.getElementById('clicked').textContent='許O軒'"></td>
  </tr>
  <tr>
    <td><input type="checkbox" id="pick2"></td><td>test02</td><td>林O華</td><td>特搜大隊</td>
    <td><input type="button" value="設定" onclick="document.getElementById('clicked').textContent='林O華(1)'"></td>
  </tr>
  <tr>
    <td><input type="checkbox" id="pick3"></td><td>test03</td><td>林O華</td><td>特搜大隊</td>
    <td><input type="button" value="設定" onclick="document.getElementById('clicked').textContent='林O華(2)'"></td>
  </tr>
  <tr>
    <td><input type="checkbox" id="pick4"></td><td>test04</td><td>陳O</td><td>特搜大隊</td>
    <td><input type="button" value="設定" onclick="document.getElementById('clicked').textContent='陳O'"></td>
  </tr>
  <tr>
    <td><input type="checkbox" id="pick5"></td><td>test05</td><td>陳O宏</td><td>特搜大隊</td>
    <td><input type="button" value="設定" onclick="document.getElementById('clicked').textContent='陳O宏'"></td>
  </tr>
</table>
<div id="clicked">(還沒點)</div>`;

/** 仿照權限設定畫面：好幾個子系統各自一列，每列旁邊都有一個一模一樣的角色下拉。 */
const PERMISSION_FIXTURE = `
<table id="subsystems">
  <tr><th>子系統</th><th>角色</th></tr>
  <tr>
    <td><input type="checkbox" id="ATM" name="subSystem[]">ATM 救護技術員管理系統</td>
    <td><select id="ATMselect"><option value="">請選擇權限</option><option value="a1">ATM001 縣市管理人員</option></select></td>
  </tr>
  <tr>
    <td><input type="checkbox" id="MCI" name="subSystem[]">MCI 大量傷病患救護管理系統</td>
    <td>
      <select id="MCIselect">
        <option value="">請選擇權限</option>
        <option value="m1">MCI001 署端使用者</option>
        <option value="m2">MCI002 縣市端使用者</option>
      </select>
    </td>
  </tr>
</table>
<input type="button" value="確定">`;

/**
 * 仿照**現代版面**的查詢頁（div 排版，不是表格）。
 *
 * 2026-08-18 第一次實跑目標系統時，三個查詢欄位全部被判成「沒有標籤」，
 * 因為當時只認得老式表格排版。這張假頁面就是照那次的教訓造的：
 * 標籤在前一個容器、在同一個容器、或根本只有 placeholder。
 */
const MODERN_FIXTURE = `
<div class="row">
  <div class="col-2"><label>單位</label></div>
  <div class="col-4">
    <select id="unitSel">
      <option value="">請選擇</option>
      <option value="1">測試甲分隊</option>
      <option value="2">測試乙分隊</option>
    </select>
  </div>
</div>
<div class="form-group"><label>姓名</label><input type="text" id="nameInput"></div>
<div class="form-group"><label>帳號關鍵字</label><input type="text" id="kwInput" value="殘留值"></div>
<div class="form-group"><label>帳號</label><input type="text" id="acctInput" value="不該被動到"></div>
<div class="form-group"><input type="text" id="phoneInput" placeholder="請輸入聯絡電話"></div>
<button type="button">搜尋</button>`;

/** 仿照登入頁：帳號、密碼、驗證碼三欄，欄位 id 取名方式與政府系統相近。 */
const LOGIN_FIXTURE = `
<form>
  <table>
    <tr><td>帳號</td><td><input type="text" name="loginId"></td></tr>
    <tr><td>密碼</td><td><input type="password" name="loginPwd"></td></tr>
    <tr><td>驗證碼</td><td><input type="text" name="checkCode"><img src="captcha.jpg"></td></tr>
  </table>
  <input type="submit" value="登入">
</form>`;

/** 依序試 Chrome、Edge；兩個都沒有就回傳 null，讓整組測試略過。 */
async function launchBrowser() {
  for (const channel of BROWSER.channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // 這台電腦沒裝這個瀏覽器，試下一個。
    }
  }
  return null;
}

const browser = await launchBrowser();
const page = browser ? await browser.newPage() : null;
const skip = browser ? false : '本機找不到 Chrome 或 Edge，略過 DOM 測試';

/** 每個測試自己決定要載哪一張假頁面。 */
async function load(fixture) {
  await page.setContent(fixture);
  return page.mainFrame();
}

test.after(async () => {
  await browser?.close();
});

test('「帳號關鍵字」不會誤中「帳號」', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const found = await findField(frame, SITE.flow.accountKeywordLabels, { tag: 'input' });
  assert.equal(found.selector, '#txtAccountKeyword');
});

test('候選字的順序不影響「完全相符優先」', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  // 就算把「帳號」排在前面，完全相符的那一欄仍應勝出。
  const found = await findField(frame, ['帳號'], { tag: 'input' });
  assert.equal(found.selector, '#txtAccount');
});

test('標籤在隔壁儲存格時也找得到姓名欄', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const found = await findField(frame, SITE.flow.nameLabels, { tag: 'input' });
  assert.equal(found.selector, '#txtName');
});

test('填姓名、清空帳號關鍵字，且不會動到隔壁的「帳號」欄', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  assert.equal((await setField(frame, SITE.flow.nameLabels, '測試甲', { tag: 'input' })).ok, true);
  assert.equal((await setField(frame, SITE.flow.accountKeywordLabels, '', { tag: 'input' })).ok, true);
  assert.equal(await frame.inputValue('#txtName'), '測試甲');
  assert.equal(await frame.inputValue('#txtAccountKeyword'), '');
  assert.equal(await frame.inputValue('#txtAccount'), '不該被動到');
});

test('單位下拉選得到完全相符的那一個', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const result = await selectOptionByText(frame, '#selUnit', ['測試乙分隊']);
  assert.equal(result.ok, true);
  assert.equal(result.chosen, '測試乙分隊');
  assert.equal(await frame.inputValue('#selUnit'), '2');
});

test('單位相符的選項不只一個時，寧可不選也不猜', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  // 「測試乙」同時符合「測試乙分隊」與「測試乙分隊第二救護隊」。
  const result = await selectOptionByText(frame, '#selUnit', ['測試乙']);
  assert.equal(result.ok, false);
  assert.match(result.reason, /不只一個/);
  assert.equal(result.ambiguous.length, 2);
  assert.equal(await frame.inputValue('#selUnit'), ''); // 沒被動過
});

test('單位打錯時回報候選，不會硬選第一個', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const result = await selectOptionByText(frame, '#selUnit', ['不存在的分隊']);
  assert.equal(result.ok, false);
  assert.ok(result.ambiguous.includes('測試甲分隊'));
  assert.equal(await frame.inputValue('#selUnit'), '');
});

test('沒有給選擇器時，可用標籤找到單位下拉', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const result = await selectOptionByText(frame, '', ['測試甲分隊'], SITE.flow.unitLabels);
  assert.equal(result.ok, true);
  assert.equal(await frame.inputValue('#selUnit'), '1');
});

test('查詢結果的「設定」按鈕數＝查到幾個人', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const hits = await findClickables(frame, SITE.flow.rowActionTexts, { exact: true });
  assert.equal(hits.length, 1);
});

test('點得到「設定」', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  assert.equal(await clickMatch(frame, SITE.flow.rowActionTexts, 0, { exact: true }), true);
});

test('選單項目文字命中的是最內層的那一個，不是整個選單容器', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const hits = await findClickables(frame, SITE.flow.accountMenuTexts, { onlyVisible: false });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, 'li');
});

test('右上角的「你好」找得到', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const hits = await findClickables(frame, SITE.flow.userMenuTexts);
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /你好/);
});

test('MCI 那一列的下拉選得到 MCI002，且不會動到別的系統那一列', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  const result = await selectOptionInRow(
    frame,
    [SITE.flow.subsystemText, ...SITE.flow.subsystemHints],
    [SITE.flow.roleText, ...SITE.flow.roleHints],
  );
  assert.equal(result.ok, true);
  assert.equal(result.chosen, 'MCI002 縣市端使用者');
  const values = await frame.$$eval('select', (selects) => selects.map((select) => select.value));
  assert.deepEqual(values, ['', 'm2']); // 第一列（ATM）完全沒被動到
});

test('角色名稱中間有沒有空格都比對得到', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  const result = await selectOptionInRow(frame, ['MCI大量傷病患'], ['MCI002縣市端使用者']);
  assert.equal(result.ok, true);
  assert.equal(result.chosen, 'MCI002 縣市端使用者');
});

test('MCI 那一列裡找得到可以操作的東西（供改版時退回按鈕流程）', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  const result = await rowAction(frame, { rowTexts: ['MCI大量傷病患'], actionTexts: [], dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.actionType, 'checkbox'); // 那一列的第一個確實是勾選框
});

test('skipToggles 時不會把勾選框當成要按的東西', { skip }, async () => {
  // 點勾選框會**切換**狀態：已經勾好的權限會被取消掉，
  // 所以後備路徑一律跳過它，只找下拉或按鈕。
  const frame = await load(PERMISSION_FIXTURE);
  const result = await rowAction(frame, {
    rowTexts: ['MCI大量傷病患'],
    actionTexts: [],
    skipToggles: true,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actionTag, 'select');
});

test('找不到那一列時明講找不到，不會退而求其次點別的', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  const result = await rowAction(frame, { rowTexts: ['這一頁沒有的系統'], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.rowCount, 0);
});

test('現代版面：標籤在前一個容器裡也找得到（單位下拉）', { skip }, async () => {
  const frame = await load(MODERN_FIXTURE);
  const found = await findField(frame, SITE.flow.unitLabels, { tag: 'select' });
  assert.equal(found.selector, '#unitSel');
});

test('現代版面：標籤是同一個容器裡的 label 也找得到（姓名）', { skip }, async () => {
  const frame = await load(MODERN_FIXTURE);
  const found = await findField(frame, SITE.flow.nameLabels, { tag: 'input' });
  assert.equal(found.selector, '#nameInput');
});

test('現代版面：「帳號關鍵字」仍然不會誤中「帳號」', { skip }, async () => {
  const frame = await load(MODERN_FIXTURE);
  assert.equal((await findField(frame, SITE.flow.accountKeywordLabels, { tag: 'input' })).selector, '#kwInput');
  assert.equal((await findField(frame, ['帳號'], { tag: 'input' })).selector, '#acctInput');
});

test('現代版面：整套填值只動該動的兩欄', { skip }, async () => {
  const frame = await load(MODERN_FIXTURE);
  await setField(frame, SITE.flow.nameLabels, '測試甲', { tag: 'input' });
  await setField(frame, SITE.flow.accountKeywordLabels, '', { tag: 'input' });
  assert.equal(await frame.inputValue('#nameInput'), '測試甲');
  assert.equal(await frame.inputValue('#kwInput'), '');
  assert.equal(await frame.inputValue('#acctInput'), '不該被動到');
});

test('現代版面：沒有標籤時用 placeholder 認欄位', { skip }, async () => {
  const frame = await load(MODERN_FIXTURE);
  const found = await findField(frame, ['聯絡電話'], { tag: 'input' });
  assert.equal(found.selector, '#phoneInput');
});

test('沒有給選擇器時，現代版面的單位下拉也選得到', { skip }, async () => {
  const frame = await load(MODERN_FIXTURE);
  const result = await selectOptionByText(frame, '', ['測試甲分隊'], SITE.flow.unitLabels);
  assert.equal(result.ok, true);
  assert.equal(await frame.inputValue('#unitSel'), '1');
});

test('排查清單會帶出 id 與 placeholder（標籤認不出來時的唯一線索）', { skip }, async () => {
  const frame = await load(MODERN_FIXTURE);
  const fields = await listFields(frame);
  const phone = fields.find((field) => field.id === 'phoneInput');
  assert.equal(phone.hint, '請輸入聯絡電話');
});

test('讀得出現況：已勾選且角色就是 MCI002 → 本來就有了', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  await frame.check('#MCI');
  await frame.selectOption('#MCIselect', 'm2');
  const state = await readSubsystemState(frame, 'MCI');
  assert.equal(state.alreadyGranted, true);
  assert.equal(state.role, 'MCI002 縣市端使用者');
});

test('角色是別的權限時不算「本來就有」', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  await frame.check('#MCI');
  await frame.selectOption('#MCIselect', 'm1');
  assert.equal((await readSubsystemState(frame, 'MCI')).alreadyGranted, false);
});

test('角色對但勾選框沒勾，也不算「本來就有」', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  await frame.selectOption('#MCIselect', 'm2');
  const state = await readSubsystemState(frame, 'MCI');
  assert.equal(state.checked, false);
  assert.equal(state.alreadyGranted, false);
});

test('認得出登入頁的帳號、密碼、驗證碼與登入鈕', { skip }, async () => {
  const frame = await load(LOGIN_FIXTURE);
  const fields = await findLoginFields(frame, SITE.loginFields);
  assert.equal(fields.username.selector, 'input[name="loginId"]');
  assert.equal(fields.password.selector, 'input[name="loginPwd"]');
  assert.equal(fields.captcha.selector, 'input[name="checkCode"]');
  assert.equal(fields.submit.text, '登入');
});

test('沒有密碼欄就不是登入頁（用來判斷登入完成了沒）', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  assert.equal(await findLoginFields(frame, SITE.loginFields), null);
});

test('數得出結果表格有幾列資料', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  assert.ok((await countDataRows(frame)) >= 1);
});

test('排查用的清單會遮掉 5 碼以上的數字（帳號可能含個資）', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const texts = (await listClickableTexts(frame, 60)).map((item) => item.text);
  assert.ok(!texts.some((text) => text.includes('0912345678')), `實際列出：${texts.join('｜')}`);
});

test('下拉選項列得出來（單位打錯時要靠這個提示正確寫法）', { skip }, async () => {
  const frame = await load(QUERY_FIXTURE);
  const selects = await listSelects(frame);
  assert.ok(selects[0].options.includes('測試甲分隊'));
});

test('認得出畫面上的錯誤訊息字樣', { skip }, async () => {
  await page.setContent('<div>查無資料</div>');
  assert.equal(await hasText(page.mainFrame(), SITE.errorMarkers), '查無資料');
});

test('取消勾選：只動畫面上看得到的那一個', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  await frame.check('#MCI');
  const result = await setVisibleCheckbox(frame, '#MCI', false);
  assert.equal(result.ok, true);
  assert.equal(result.checked, false);
  assert.equal(await frame.isChecked('#MCI'), false);
});

test('本來就沒勾的不會被反而勾起來', { skip }, async () => {
  // 全面取消時對「本來就沒有權限」的人呼叫，絕不能幫他勾上去。
  const frame = await load(PERMISSION_FIXTURE);
  const result = await setVisibleCheckbox(frame, '#MCI', false);
  assert.equal(result.checked, false);
  assert.equal(await frame.isChecked('#MCI'), false);
});

test('取消 MCI 不會動到別的子系統', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  await frame.check('#MCI');
  await frame.check('#ATM');
  await setVisibleCheckbox(frame, '#MCI', false);
  assert.equal(await frame.isChecked('#ATM'), true, '隔壁子系統的權限不該被碰');
});

test('讀得出勾選框的現況（取消之前要先看）', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  await frame.check('#MCI');
  const dom = await readSubsystemDom(frame, '#MCI', '#MCIselect');
  assert.equal(dom.checkbox.checked, true);
  assert.equal(dom.checkbox.visibleCount, 1);
});

// ── 全面取消：先掃出「一個單位裡有誰」──────────────────────────────

test('列得出單位下拉的每一個選項（含 value）', { skip }, async () => {
  const frame = await load(UNIT_LIST_FIXTURE);
  const options = await listOptions(frame, '#searchDeptNotNfa');
  assert.deepEqual(options.map((option) => option.text), ['請選擇', '緊急救護科', '測試甲分隊']);
  assert.equal(options[0].value, '', '「請選擇」沒有 value，掃描時要略過');
  assert.equal(options[2].value, 'B1');
});

test('讀得出結果表格「姓名」那一欄', { skip }, async () => {
  const frame = await load(UNIT_LIST_FIXTURE);
  const column = await readResultColumn(frame, SITE.flow.resultNameHeaders, SITE.flow.rowActionTexts);
  assert.equal(column.ok, true);
  assert.deepEqual(column.values, ['測試甲', '測試乙', '測試丙']);
});

test('不會把查詢條件區誤當成結果表格', { skip }, async () => {
  // 查詢條件區本身也是一張表格，而且第一列剛好寫著「單位　姓名」。
  // 沒有「表格裡要有設定按鈕」這道關卡的話，會讀出一堆不是人名的東西。
  const frame = await load(UNIT_LIST_FIXTURE);
  const column = await readResultColumn(frame, SITE.flow.resultNameHeaders, SITE.flow.rowActionTexts);
  assert.ok(!column.values.some((value) => value.includes('搜尋')), `實際讀到：${column.values.join('｜')}`);
});

test('結果表格沒有「姓名」欄時如實回報，並帶回看到的欄位標題', { skip }, async () => {
  await page.setContent(`
    <table>
      <tr><th>帳號</th><th>單位</th><th>功能</th></tr>
      <tr><td>test01</td><td>測試甲分隊</td><td><input type="button" value="設定"></td></tr>
    </table>`);
  const column = await readResultColumn(page.mainFrame(), SITE.flow.resultNameHeaders, SITE.flow.rowActionTexts);
  assert.equal(column.ok, false);
  assert.ok(column.headers.includes('帳號'), `實際看到的標題：${column.headers.join('｜')}`);
});

test('認得出「顯示成這個名字的那一列」，按下它的設定', { skip }, async () => {
  // 系統顯示的姓名是遮蔽過的（許O軒），拿去查一定 0 筆，只能認那一列。
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    rowTexts: ['許O軒'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, true);
  assert.equal(await frame.textContent('#clicked'), '許O軒');
});

test('那一列的勾選框不會被誤點成「設定」', { skip }, async () => {
  // 沒有 requireActionText 的話，沒有文字的勾選框會排在按鈕前面而被點到。
  const frame = await load(MASKED_LIST_FIXTURE);
  await rowAction(frame, {
    rowTexts: ['許O軒'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(await frame.isChecked('#pick1'), false, '勾選框不該被動到');
});

test('同一個遮蔽後的名字出現兩次時寧可不點', { skip }, async () => {
  // 那種情況連人看畫面也分不出是哪一位。
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    rowTexts: ['林O華'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /不只一列/);
  assert.equal(await frame.textContent('#clicked'), '(還沒點)');
});

test('兩個字的名字（陳O）不會誤中同姓的長名字（陳O宏）', { skip }, async () => {
  // 2026-08-24 實跑卡住的那一種：遮蔽後的 `陳O` 是同單位 `陳O宏`、`陳O婷`… 的開頭。
  // 改成「姓名格完全相符」之後，只會中自己那一列。
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    cellTexts: ['陳O'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, true);
  assert.equal(await frame.textContent('#clicked'), '陳O');
});

test('用舊的「整列文字包含」比對時，陳O 確實會中不只一列（這就是要改的原因）', { skip }, async () => {
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    rowTexts: ['陳O'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.rowCount, 2);
  assert.equal(await frame.textContent('#clicked'), '(還沒點)');
});

test('同名兩位靠帳號分得出來，而且點到的是帳號相符的那一位', { skip }, async () => {
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    cellTexts: ['林O華', 'test03'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, true);
  assert.equal(await frame.textContent('#clicked'), '林O華(2)', '帳號 test03 是第二位');
});

test('同名兩位、只給姓名時仍然寧可不點', { skip }, async () => {
  // 沒有帳號可比（舊名單）時，安全網還在：認不出來就跳過，不亂點。
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    cellTexts: ['林O華'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.rowCount, 2);
  assert.equal(await frame.textContent('#clicked'), '(還沒點)');
});

test('帳號對不上時一列都不中（呼叫端才好退回只比姓名）', { skip }, async () => {
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    cellTexts: ['許O軒', '這個帳號不存在'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.rowCount, 0);
});

test('讀姓名欄時順便把帳號欄一起讀回來（位置一一對應）', { skip }, async () => {
  const frame = await load(MASKED_LIST_FIXTURE);
  const column = await readResultColumn(
    frame,
    SITE.flow.resultNameHeaders,
    SITE.flow.rowActionTexts,
    SITE.flow.resultAccountHeaders,
  );
  assert.equal(column.ok, true);
  assert.deepEqual(column.values, ['許O軒', '林O華', '林O華', '陳O', '陳O宏']);
  assert.deepEqual(column.extras, ['test01', 'test02', 'test03', 'test04', 'test05']);
});

test('沒有帳號欄時照樣讀得到姓名，帳號一律是空字串', { skip }, async () => {
  // 少一項辨識依據不該讓整張表作廢——同名時才會卡住，其餘照跑。
  await page.setContent(`
    <table>
      <tr><th>姓名</th><th>單位</th><th>功能</th></tr>
      <tr><td>測試甲</td><td>測試甲分隊</td><td><input type="button" value="設定"></td></tr>
    </table>`);
  const column = await readResultColumn(
    page.mainFrame(),
    SITE.flow.resultNameHeaders,
    SITE.flow.rowActionTexts,
    SITE.flow.resultAccountHeaders,
  );
  assert.equal(column.ok, true);
  assert.deepEqual(column.values, ['測試甲']);
  assert.deepEqual(column.extras, ['']);
});

test('這一頁沒有那個人時回報 rowCount 0（呼叫端據此翻下一頁）', { skip }, async () => {
  const frame = await load(MASKED_LIST_FIXTURE);
  const result = await rowAction(frame, {
    rowTexts: ['趙O雲'],
    actionTexts: SITE.flow.rowActionTexts,
    requireUnique: true,
    skipToggles: true,
    requireActionText: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.rowCount, 0);
});

test('「下一頁」用完全相符比對，不會誤按「上一頁」', { skip }, async () => {
  const frame = await load(UNIT_LIST_FIXTURE);
  const hits = await findClickables(frame, SITE.flow.nextPageTexts, { exact: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, '下一頁');
});
