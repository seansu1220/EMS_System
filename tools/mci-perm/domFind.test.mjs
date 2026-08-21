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
  listSelects,
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
  // 撤銷時對「本來就沒有權限」的人呼叫，絕不能幫他勾上去。
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

test('讀得出勾選框的現況（撤銷前要先看）', { skip }, async () => {
  const frame = await load(PERMISSION_FIXTURE);
  await frame.check('#MCI');
  const dom = await readSubsystemDom(frame, '#MCI', '#MCIselect');
  assert.equal(dom.checkbox.checked, true);
  assert.equal(dom.checkbox.visibleCount, 1);
});
