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
  findPageMarker,
  findSelectByOption,
  findMarkedRows,
  findRowsWithColumnValue,
  findRowsByColumnValue,
  clickRowButtonByColumnValue,
  listCheckboxLabels,
  listTableHeaders,
} from './pageFinder.mjs';
import { setCheckbox, selectField } from './formFill.mjs';

/**
 * 仿照目標系統的版面：老式表格排版、勾選框的 id 全是看不懂的代碼、
 * 標籤文字就寫在同一格或隔壁格，另外故意放了幾個容易誤中的誘餌。
 */
const FIXTURE = `
<!--
  仿解鎖成功後左上角出現的那行紅字（使用者 2026-08-05 描述的成功畫面）。
  外面刻意包一層容器，驗證抓到的是**那一行字**而不是整頁的文字。
-->
<div id="banner"><span style="color:red">已修改為未結案並解鎖</span></div>
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
  <!--
    仿查詢頁那排案件註記（2026-09-01 實跑踩到）：四個共用 name="_cba"，而 **id 全是空的**。
    用 name 當選擇器會一次選到四個，所以必須當場補 id 才指得到其中一個。
  -->
  <tr>
    <td><input type="checkbox" name="_cba">危急個案</td>
    <td><input type="checkbox" name="_cba">大傷案件</td>
    <td><input type="checkbox" name="_cba">毒化災</td>
    <td><input type="checkbox" name="_cba">輻射傷害</td>
  </tr>
  <!--
    仿「整組隱藏的重複欄位」：文字一模一樣，但看不見的那一組操作了等於沒設條件。
    刻意把看不見的那個放在前面——照 DOM 順序取就會取錯。
  -->
  <tr style="display:none">
    <td><input type="checkbox" id="_scarSubcbc040901">因交通事故</td>
  </tr>
  <tr>
    <td><input type="checkbox" id="_scarcbc040901">因交通事故</td>
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
</table>
<!--
  仿「系統設定 → 線上使用狀況」那張表（2026-09-11 探測到的真實結構）。
  這是第二種解鎖路徑要動手的地方，刪錯一列無法復原，因此誘餌放得特別狠：

  - **每一列的刪除鈕 id 全都是 _btnDelete**（真實系統就是這樣）→ 靠 id 或序號必然刪錯
  - 第 2 列的 TEMSIS 是第 1 列的**超集**（尾巴多一碼）→ 用「包含」比對就會多刪一列
  - 第 4 列的刪除鈕 onclick 帶的是**第 1 列的**編號 → 按鈕與所在列對不起來，必須擋下
  - 第 5、6 列是**同一個編號的兩列** → 任何選擇都是猜的，一律不動手
  - 第 3 列**沒有刪除鈕** → 不可以退而求其次去按別列的

  onclick 仿真實系統那種 (^w^) 分隔的參數，並順手把按到誰記在 window 上，
  測試才驗得到「真的按到那一列」，而不只是「有按到東西」。
-->
<table id="table1">
  <tr>
    <th>項次</th><th>案件編號</th><th>TEMSIS ID</th><th>救護車</th>
    <th>使用者</th><th>日期</th><th>裝置ID</th><th>&nbsp;</th>
  </tr>
  <tr>
    <td>1</td><td>A0001</td><td>2026091110100300000001</td><td>中路92</td>
    <td>tyfd01</td><td>2026/09/11 09:59:22</td><td>DEV-1</td>
    <td><input type="button" id="_btnDelete" name="_btnDelete" value="刪除"
      onclick="window.__deleted='A0001(^w^)2026091110100300000001(^w^)tyfd01(^w^)2026/09/11 09:59:22(^w^)DEV-1(^w^)中路92'"></td>
  </tr>
  <tr>
    <td>2</td><td>A0002</td><td>20260911101003000000012</td><td>竹圍92</td>
    <td>tyfd02</td><td>2026/09/10 08:00:00</td><td>DEV-2</td>
    <td><input type="button" id="_btnDelete" name="_btnDelete" value="刪除"
      onclick="window.__deleted='A0002(^w^)20260911101003000000012(^w^)tyfd02(^w^)2026/09/10 08:00:00(^w^)DEV-2(^w^)竹圍92'"></td>
  </tr>
  <tr>
    <td>3</td><td>A0003</td><td>2026091110100300000003</td><td>高平91</td>
    <td>tyfd03</td><td>2026/09/09 07:00:00</td><td>DEV-3</td>
    <td>&nbsp;</td>
  </tr>
  <tr>
    <td>4</td><td>A0004</td><td>2026091110100300000004</td><td>草漯93</td>
    <td>tyfd04</td><td>2026/09/08 06:00:00</td><td>DEV-4</td>
    <td><input type="button" id="_btnDelete" name="_btnDelete" value="刪除"
      onclick="window.__deleted='A0001(^w^)2026091110100300000001(^w^)tyfd01(^w^)2026/09/11 09:59:22(^w^)DEV-1(^w^)中路92'"></td>
  </tr>
  <tr>
    <td>5</td><td>A0005</td><td>2026091110100300000005</td><td>幼獅92</td>
    <td>tyfd05</td><td>2026/09/07 05:00:00</td><td>DEV-5</td>
    <td><input type="button" id="_btnDelete" name="_btnDelete" value="刪除"
      onclick="window.__deleted='A0005(^w^)2026091110100300000005(^w^)tyfd05(^w^)2026/09/07 05:00:00(^w^)DEV-5(^w^)幼獅92'"></td>
  </tr>
  <tr>
    <td>7</td><td>A0007</td><td></td><td>大湳93</td>
    <td>tyfd07</td><td>2026/09/05 03:00:00</td><td>DEV-7</td>
    <td><input type="button" id="_btnDelete" name="_btnDelete" value="刪除"
      onclick="window.__deleted='A0007(^w^)(^w^)tyfd07(^w^)2026/09/05 03:00:00(^w^)DEV-7(^w^)大湳93'"></td>
  </tr>
  <tr><td colspan="8">（跨欄的版面列，欄數不足）</td></tr>
  <tr>
    <td>6</td><td>A0006</td><td>2026091110100300000005</td><td>埔心91</td>
    <td>tyfd06</td><td>2026/09/06 04:00:00</td><td>DEV-6</td>
    <td><input type="button" id="_btnDelete" name="_btnDelete" value="刪除"
      onclick="window.__deleted='A0006(^w^)2026091110100300000005(^w^)tyfd06(^w^)2026/09/06 04:00:00(^w^)DEV-6(^w^)埔心91'"></td>
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

test('找得到解鎖成功的那行系統訊息，並只帶回那一行字', { skip }, async () => {
  const found = await findPageMarker(frame, ['已修改為未結案並解鎖']);
  assert.equal(found.marker, '已修改為未結案並解鎖');
  assert.equal(found.text, '已修改為未結案並解鎖');
});

test('系統訊息的比對忽略空白與標點差異', { skip }, async () => {
  // 舊系統常把訊息寫成「已修改為未結案 並解鎖！」這種形式，不正規化就比對不到。
  assert.ok(await findPageMarker(frame, ['已修改為未結案 並解鎖']));
});

test('候選字樣的順序決定回報哪一個', { skip }, async () => {
  const found = await findPageMarker(frame, ['已修改為未結案', '已修改為未結案並解鎖']);
  assert.equal(found.marker, '已修改為未結案');
});

test('畫面上沒有這段訊息時回傳 null，不可以硬說有', { skip }, async () => {
  assert.equal(await findPageMarker(frame, ['解鎖失敗']), null);
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

test('id 是空的勾選框也指得到，而且只勾到那一個', { skip }, async () => {
  // 2026-09-01 第一次實跑就卡在這裡：查詢頁那排案件註記四個共用一個 name、id 全是空的。
  const found = await findCheckbox(frame, ['危急個案']);
  assert.ok(found?.selector.startsWith('#'), `應該補出一個 id 選擇器，實際：${found?.selector}`);
  assert.equal(found.labelText, '危急個案');

  await setCheckbox(frame, found.selector, true, '危急個案');
  const group = frame.locator('input[name="_cba"]');
  assert.equal(await group.nth(0).isChecked(), true);
  assert.equal(await group.nth(1).isChecked(), false, '同名的其他三個不可以被一起勾');
  assert.equal(await group.nth(2).isChecked(), false);
});

test('文字一樣好時，看得見的那一個優先（隱藏的重複欄位操作了等於沒設）', { skip }, async () => {
  const found = await findCheckbox(frame, ['因交通事故']);
  assert.equal(found.selector, '#_scarcbc040901', '不可以取到 DOM 在前面、但看不見的那一個');
  assert.equal(found.visible, true);
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


// ── 線上使用狀況：找出該刪的那一列（第二種解鎖路徑） ──────────────────
//
// 這一組是全檔風險最高的測試：真實系統裡按下去就是不可復原的刪除，
// 而每一列的按鈕 id 完全相同，唯一能分辨的只有「在不在同一個 <tr>」。

/** 用假表的欄位設定叫 findRowsByColumnValue。 */
function scanUsage(temsis) {
  return findRowsByColumnValue(frame, {
    value: temsis,
    columnCandidates: ['TEMSIS ID'],
    buttonTexts: ['刪除'],
    wantedHeaders: ['救護車', '日期'],
  });
}

/** 按下之前先把「按到誰」的紀錄清掉，才驗得出這一次到底有沒有按。 */
async function resetClickRecord() {
  await frame.evaluate(() => { window.__deleted = null; });
}

test('線上使用狀況：找得到相符的那一列，並帶回該列的救護車與日期', { skip }, async () => {
  const scan = await scanUsage('2026091110100300000001');
  assert.equal(scan.found, true);
  assert.equal(scan.matches.length, 1);
  assert.equal(scan.matches[0].hasButton, true);
  assert.equal(scan.matches[0].buttonSelfIdentifies, true);
  assert.equal(scan.matches[0].values['救護車'], '中路92');
  assert.equal(scan.matches[0].values['日期'], '2026/09/11 09:59:22');
});

test('線上使用狀況：編號比對是完全相等，尾巴多一碼的那一列不算', { skip }, async () => {
  // 用「包含」比對的話，第 2 列（尾巴多一碼）會跟著被算進來，於是多刪一筆別人的。
  const scan = await scanUsage('2026091110100300000001');
  assert.equal(scan.matches.length, 1, '只有第 1 列才是這個編號');
  assert.equal(scan.matches[0].values['救護車'], '中路92');
});

test('線上使用狀況：只帶回指定欄位，使用者與裝置ID 不外流', { skip }, async () => {
  const scan = await scanUsage('2026091110100300000001');
  assert.deepEqual(Object.keys(scan.matches[0].values).sort(), ['日期', '救護車'].sort());
  const dumped = JSON.stringify(scan.matches[0].values);
  assert.ok(!dumped.includes('tyfd01'), '不該把使用者帳號帶出來');
  assert.ok(!dumped.includes('DEV-1'), '不該把裝置ID帶出來');
});

test('線上使用狀況：那一列沒有刪除鈕時如實回報，不去抓別列的', { skip }, async () => {
  const scan = await scanUsage('2026091110100300000003');
  assert.equal(scan.matches.length, 1);
  assert.equal(scan.matches[0].hasButton, false);
});

test('線上使用狀況：按鈕帶的編號與所在列對不起來時要看得出來', { skip }, async () => {
  // 第 4 列的按鈕 onclick 帶的是第 1 列的編號——這正是「按下去會刪到別排」的樣子。
  const scan = await scanUsage('2026091110100300000004');
  assert.equal(scan.matches.length, 1);
  assert.equal(scan.matches[0].hasButton, true);
  assert.equal(scan.matches[0].buttonSelfIdentifies, false);
});

test('線上使用狀況：找不到 TEMSIS 欄時回報版面欄位，不當成「沒有這筆」', { skip }, async () => {
  const scan = await findRowsByColumnValue(frame, {
    value: '2026091110100300000001',
    columnCandidates: ['這個欄位不存在'],
    buttonTexts: ['刪除'],
  });
  assert.equal(scan.found, false);
  assert.equal(scan.reason, 'noColumn');
  assert.ok(scan.tableHeaders.length > 0, '要列出這一頁實際有哪些欄位供排查');
});

test('線上使用狀況：按下去的是同一列的那顆鈕，不是第幾顆', { skip }, async () => {
  // 六列的刪除鈕 id 全是 _btnDelete，序號定位必然刪錯；這裡驗證真的按到第 1 列。
  await resetClickRecord();
  const result = await clickRowButtonByColumnValue(frame, {
    value: '2026091110100300000001',
    columnCandidates: ['TEMSIS ID'],
    buttonTexts: ['刪除'],
  });
  assert.equal(result.clicked, true);
  const payload = await frame.evaluate(() => window.__deleted);
  assert.ok(payload.includes('2026091110100300000001'), '按到的必須是這個編號那一列');
  assert.ok(payload.includes('中路92'), '按到的必須是中路92那一列');
});

test('線上使用狀況：同一個編號有兩列時一個都不按', { skip }, async () => {
  await resetClickRecord();
  const result = await clickRowButtonByColumnValue(frame, {
    value: '2026091110100300000005',
    columnCandidates: ['TEMSIS ID'],
    buttonTexts: ['刪除'],
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'notUnique');
  assert.equal(await frame.evaluate(() => window.__deleted), null, '一個都不可以按下去');
});

test('線上使用狀況：按鈕與所在列對不起來時不按', { skip }, async () => {
  await resetClickRecord();
  const result = await clickRowButtonByColumnValue(frame, {
    value: '2026091110100300000004',
    columnCandidates: ['TEMSIS ID'],
    buttonTexts: ['刪除'],
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'buttonMismatch');
  assert.equal(await frame.evaluate(() => window.__deleted), null, '按下去就會刪到第 1 列');
});

test('線上使用狀況：那一列沒有刪除鈕時不按', { skip }, async () => {
  await resetClickRecord();
  const result = await clickRowButtonByColumnValue(frame, {
    value: '2026091110100300000003',
    columnCandidates: ['TEMSIS ID'],
    buttonTexts: ['刪除'],
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'noButton');
  assert.equal(await frame.evaluate(() => window.__deleted), null);
});

test('線上使用狀況：清單裡沒有這筆時不按，且回報 notFound', { skip }, async () => {
  await resetClickRecord();
  const result = await clickRowButtonByColumnValue(frame, {
    value: '9999999999999999999999',
    columnCandidates: ['TEMSIS ID'],
    buttonTexts: ['刪除'],
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'notFound');
  assert.equal(await frame.evaluate(() => window.__deleted), null);
});

test('線上使用狀況：比對值是空的時候一律當成找不到，不可以對上空欄位', { skip }, async () => {
  // 空字串會與空儲存格相等，放行的話有機會刪到一列根本沒填編號的資料。
  await resetClickRecord();
  const result = await clickRowButtonByColumnValue(frame, {
    value: '',
    columnCandidates: ['TEMSIS ID'],
    buttonTexts: ['刪除'],
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'notFound');
  assert.equal(await frame.evaluate(() => window.__deleted), null);
});

test('線上使用狀況：表格有跨欄的版面列時照樣掃得完，不會整個拋錯', { skip }, async () => {
  // 欄數不足的列讀 undefined.textContent 會讓整個 evaluate 掛掉，連掃描結果都拿不到。
  const scan = await scanUsage('2026091110100300000005');
  assert.equal(scan.found, true);
  assert.equal(scan.matches.length, 2, '兩列同編號的還是要找得到');
});
