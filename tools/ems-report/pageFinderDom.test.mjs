/**
 * 頁面定位邏輯的 DOM 測試：用一張**自己造的假頁面**，在真的瀏覽器裡驗證
 * `pageFinder.mjs` 找不找得到欄位。
 *
 * 為什麼需要這一組：`queryPage` 裡的程式碼是送進瀏覽器執行的，
 * 沒辦法用一般的單元測試涵蓋，而它一旦找錯欄位，報表看起來完全正常、數字卻是錯的
 * （第 1 章就發生過「整份報表只有一個叫 V 的分隊」）。目標系統又不能拿來反覆試，
 * 因此改為造一張版面特徵相同的假頁面來測。
 *
 * ⚠ 這張假頁面裡沒有任何真實資料，全部是為了測試而編的。
 * ⚠ 本機沒有 Chrome／Edge 時整組自動略過，不讓其他測試跟著失敗。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BROWSER } from './config.mjs';
import {
  findCheckbox,
  findSelectByOption,
  findMarkedRows,
  findRowsWithColumnValue,
  listCheckboxLabels,
  listTableHeaders,
} from './pageFinder.mjs';
import { setCheckbox, selectField } from './formFill.mjs';

/**
 * 仿照目標系統的版面：老式表格排版、勾選框的 id 全是看不懂的代碼、
 * 標籤文字就寫在同一格或隔壁格，另外故意放了幾個容易誤中的誘餌。
 */
const FIXTURE = `
<table>
  <tr>
    <td><input type="checkbox" id="_scarcbc040101">氣管內管</td>
    <td><input type="checkbox" id="_scarcbc040102">EKG檢查</td>
    <td><input type="checkbox" id="_scarcbc040103">EKG判讀教學</td>
  </tr>
  <tr>
    <td>血糖檢查</td><td><input type="checkbox" id="_chkGLU"></td>
  </tr>
  <!-- 收合的進階搜尋區塊：欄位存在但看不見，程式仍必須設定得進去 -->
  <tr style="display:none">
    <td><input type="checkbox" id="_chkHidden">收合區塊裡的項目</td>
  </tr>
  <tr>
    <td colspan="3">
      <select id="_selSTATUS">
        <option value=""></option>
        <option value="0">已結案</option>
      </select>
      <select id="_selECG">
        <option value=""></option>
        <option value="1">單導程心電圖</option>
        <option value="2">12導程心電圖</option>
      </select>
    </td>
  </tr>
</table>
<!--
  仿案件內部的「上傳」清單（2026-08-04 實測到的真實欄位）。
  第 4 列是關鍵誘餌：檔案類型不是 12 導程，但**備註裡有「12導程」三個字**。
  比對整列文字的話它會被誤算成有做（2026-08-05 使用者指正後改為只認檔案類型欄）。
-->
<table>
  <tr>
    <th>項次</th><th>上傳時間</th><th>檔案類型</th><th>上傳者</th><th>檔案說明／備註</th>
  </tr>
  <tr><td>1</td><td>2026/07/02 11:05:00</td><td>血氧紀錄</td><td>王小明</td><td>血氧</td></tr>
  <tr><td>2</td><td>2026/07/02 12:30:00</td><td>12導程心電圖</td><td>王小明</td><td>ZOLL介接心電圖</td></tr>
  <tr><td>3</td><td>2026/07/02 13:10:00</td><td>12導程心電圖</td><td>王小明</td><td>ZOLL12導程附檔上傳(JSON檔)</td></tr>
  <tr><td>4</td><td>2026/07/02 10:00:00</td><td>其他</td><td>王小明</td><td>12導程操作說明書</td></tr>
</table>
<!--
  仿「傳輸紀錄」那張生命徵象量測表（2026-08-04 實測到的真實欄位）。
  重點：EKG 是**欄位標題**，資料列裡放的是量測數值——
  用「內容含 EKG／12導程」的方式找列永遠找不到，必須改成「找 EKG 那一欄有值的列」。
  另外故意放一個「EKG判讀狀態」欄當誘餌，驗證欄名是完全相等比對。
-->
<table>
  <tr>
    <th>量測時間</th><th>儀器</th><th>呼吸</th><th>脈搏</th><th>血壓</th>
    <th>SpO2</th><th>EKG</th><th>EKG判讀狀態</th>
  </tr>
  <tr>
    <td>2026/07/01 09:40:00</td><td>ZOLL</td><td>18</td><td>96</td><td>130/80</td>
    <td>97</td><td></td><td>未判讀</td>
  </tr>
  <tr>
    <td>2026/07/01 09:33:16</td><td>ZOLL</td><td>20</td><td>102</td><td>128/76</td>
    <td>96</td><td>V</td><td>已判讀</td>
  </tr>
  <tr>
    <td>2026/07/01 09:55:00</td><td>ZOLL</td><td>19</td><td>98</td><td>126/78</td>
    <td>98</td><td>-</td><td>未判讀</td>
  </tr>
</table>`;

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
if (page) await page.setContent(FIXTURE);
/** 假頁面沒有 frameset，主 frame 就等同工具平常拿到的內容框。 */
const frame = page?.mainFrame() ?? null;

const skip = browser ? false : '本機找不到 Chrome 或 Edge，略過 DOM 測試';

test.after(async () => {
  await browser?.close();
});

test('用旁邊的文字找得到 EKG檢查，且不會誤中「EKG判讀教學」', { skip }, async () => {
  const found = await findCheckbox(frame, ['EKG檢查', 'EKG']);
  assert.equal(found.selector, '#_scarcbc040102');
  assert.equal(found.checked, false);
});

test('候選字樣的順序決定優先權，排前面的先中', { skip }, async () => {
  // 「EKG檢查」與「EKG判讀教學」都含有 EKG，靠設定檔的候選順序決定要哪一個。
  assert.equal(
    (await findCheckbox(frame, ['EKG判讀教學', 'EKG檢查'])).selector,
    '#_scarcbc040103',
  );
  assert.equal(
    (await findCheckbox(frame, ['EKG檢查', 'EKG判讀教學'])).selector,
    '#_scarcbc040102',
  );
});

test('完全相符勝過只是包含', { skip }, async () => {
  const exact = await findCheckbox(frame, ['EKG判讀教學']);
  assert.equal(exact.selector, '#_scarcbc040103');
  assert.match(exact.matchedBy, /完全相符/);
});

test('標籤在隔壁儲存格時也找得到', { skip }, async () => {
  const found = await findCheckbox(frame, ['血糖檢查']);
  assert.equal(found.selector, '#_chkGLU');
});

test('找不到就回傳 null，不隨便挑一個勾選框', { skip }, async () => {
  assert.equal(await findCheckbox(frame, ['這一頁沒有的字樣']), null);
});

test('找不到時列得出這一頁的勾選框旁邊各寫著什麼（供排查）', { skip }, async () => {
  const labels = await listCheckboxLabels(frame);
  assert.ok(labels.some((text) => text.includes('EKG檢查')), `實際列出：${labels.join('｜')}`);
});

test('用選項文字反推得出心電圖是哪一個下拉，並取到正確的 value', { skip }, async () => {
  const found = await findSelectByOption(frame, ['12導程心電圖', '12導程']);
  assert.equal(found.selector, '#_selECG');
  assert.equal(found.optionValue, '2');
  assert.equal(found.optionText, '12導程心電圖');
});

test('沒有任何下拉含該選項時回傳 null', { skip }, async () => {
  assert.equal(await findSelectByOption(frame, ['這個選項不存在']), null);
});

test('勾選框設定得進去，而且回讀確認得到', { skip }, async () => {
  await setCheckbox(frame, '#_scarcbc040102', true, 'EKG檢查');
  assert.equal(await frame.locator('#_scarcbc040102').isChecked(), true);
  // 兩次查詢之間要把上一次的條件清掉，取消勾選同樣必須確實生效。
  await setCheckbox(frame, '#_scarcbc040102', false, 'EKG檢查');
  assert.equal(await frame.locator('#_scarcbc040102').isChecked(), false);
});

test('欄位在收合區塊裡看不見時，照樣設定得進去（不是白等 10 秒後失敗）', { skip }, async () => {
  await setCheckbox(frame, '#_chkHidden', true, '收合區塊裡的項目');
  assert.equal(await frame.locator('#_chkHidden').isChecked(), true);
});

test('設定不存在的欄位時明確報錯，不會默默當成設好了', { skip }, async () => {
  // 靜默失敗最危險：條件沒設定進去，這個系統會回傳「全部資料」而不是報錯。
  await assert.rejects(
    () => setCheckbox(frame, '#這個欄位不存在', true, '不存在的欄位'),
    /回讀不符/,
  );
});

test('下拉選單選得到，選錯值會被回讀擋下', { skip }, async () => {
  await selectField(frame, '#_selECG', '2', '心電圖＝12導程心電圖');
  assert.equal(await frame.locator('#_selECG').inputValue(), '2');
  await selectField(frame, '#_selECG', '', '心電圖＝不限');
  assert.equal(await frame.locator('#_selECG').inputValue(), '');
  await assert.rejects(() => selectField(frame, '#_selECG', '99', '不存在的選項'), /回讀不符/);
});

test('傳輸紀錄：找得出 EKG 那一欄有值的列，空的與「-」都不算', { skip }, async () => {
  const found = await findRowsWithColumnValue(frame, ['EKG'], ['量測時間']);
  assert.equal(found.matched.length, 1, '只有 EKG 欄寫著 V 的那一列算數');
  assert.equal(found.matched[0].values['量測時間'], '2026/07/01 09:33:16');
  assert.equal(found.matched[0].marker, 'V');
});

test('欄名用完全相等比對，「EKG」不會誤中「EKG判讀狀態」', { skip }, async () => {
  // 誘餌欄每一列都有值；若誤中它，三列全會被當成做過心電圖。
  const found = await findRowsWithColumnValue(frame, ['EKG'], ['量測時間']);
  assert.notEqual(found.matched.length, 3, '誤中 EKG判讀狀態 就會變成 3 列');
});

test('傳輸紀錄只帶回指定欄位，不把血壓脈搏等整列內容撈出來', { skip }, async () => {
  const found = await findRowsWithColumnValue(frame, ['EKG'], ['量測時間']);
  assert.deepEqual(Object.keys(found.matched[0].values), ['量測時間'],
    '個資防護：沒點名的欄位一律不回傳');
});

test('找不到目標欄位時回傳空陣列，不亂猜一欄', { skip }, async () => {
  const found = await findRowsWithColumnValue(frame, ['這一頁沒有的欄'], ['量測時間']);
  assert.deepEqual(found.matched, []);
});

test('listTableHeaders 列得出每張表的欄位，供對不上時排查', { skip }, async () => {
  const tables = await listTableHeaders(frame);
  assert.ok(tables.some((text) => text.includes('量測時間') && text.includes('EKG')),
    `實際列出：${tables.join(' / ')}`);
  assert.ok(tables.some((text) => text.includes('上傳時間')));
});

test('上傳清單只認「檔案類型」欄，備註寫著 12導程 的不算', { skip }, async () => {
  // 2026-08-05 使用者指正：原本比對整列文字，備註欄的「ZOLL12導程附檔上傳」
  // 或「12導程操作說明書」都會矇混過關。
  const found = await findRowsWithColumnValue(
    frame,
    ['檔案類型'],
    ['上傳時間', '檔案類型'],
    { valueMarkers: ['12導程'] },
  );
  assert.equal(found.matched.length, 2, '第 4 列檔案類型是「其他」，不該算進來');
  assert.ok(found.matched.every((row) => row.values['檔案類型'].includes('12導程')));
  assert.deepEqual(
    found.matched.map((row) => row.values['上傳時間']),
    ['2026/07/02 12:30:00', '2026/07/02 13:10:00'],
    '取到的是那兩列的上傳時間，不含 10:00 那筆說明書',
  );
});

test('上傳清單不把上傳者姓名帶出來', { skip }, async () => {
  const found = await findRowsWithColumnValue(
    frame,
    ['檔案類型'],
    ['上傳時間', '檔案類型'],
    { valueMarkers: ['12導程'] },
  );
  assert.deepEqual(Object.keys(found.matched[0].values), ['上傳時間', '檔案類型'],
    '個資防護：沒點名的欄位（上傳者、備註）一律不回傳');
});

test('沒給 valueMarkers 時維持「這一欄有值就算」（傳輸紀錄的用法）', { skip }, async () => {
  const found = await findRowsWithColumnValue(frame, ['檔案類型'], ['上傳時間']);
  assert.equal(found.matched.length, 4, '四列的檔案類型都有值');
});

test('只取出含「12導程」的那幾列，其他列不帶出來', { skip }, async () => {
  const found = await findMarkedRows(frame, ['12導程']);
  assert.ok(found.rows.every((row) => row.some((cell) => cell.includes('12導程'))));
  assert.ok(
    found.rows.every((row) => !row.some((cell) => cell.includes('血氧'))),
    '不得把沒命中的列一起帶出來（個資防護的重點）',
  );
});
