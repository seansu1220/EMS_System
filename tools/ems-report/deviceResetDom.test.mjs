/**
 * 裝置管理清單的 DOM 測試：用一張**自己造的假頁面**，在真的瀏覽器裡驗證
 * `pageFinder.mjs` 的 `statusRows`／`clickStatusRow` 找得對、按得對。
 *
 * 假頁面的按鈕會像真系統一樣改掉同一列的狀態與「最後更新時間」，
 * 用來驗證「鎖定之後時間變了，仍找得回同一列去按啟用」。
 *
 * ⚠ 這張假頁面裡沒有任何真實資料，全部是為了測試而編的。
 * ⚠ 本機沒有 Chrome／Edge 時整組自動略過。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BROWSER, UNLOCK } from './config.mjs';
import { clickStatusRowButton, findStatusRows } from './pageFinder.mjs';

const FIXTURE = `
<script>
  window.__clicks = [];
  function press(button, status) {
    const row = button.closest('tr');
    window.__clicks.push(row.cells[1].textContent + ':' + status);
    row.cells[4].textContent = status;
    row.cells[5].textContent = '2026/10/29 09:' + String(window.__clicks.length).padStart(2, '0');
  }
</script>
<table id="layout"><tr><td>系統設定 ＞ 裝置管理</td></tr></table>
<table id="devices">
  <tr><th>項次</th><th>裝置ID</th><th>救護車</th><th>使用者</th><th>狀態</th><th>最後更新時間</th><th>操作</th></tr>
  <tr><td>1</td><td>DEV-A</td><td>桃園91</td><td>tyfd01</td><td>持續取得資料</td><td>2026/10/29 08:00</td>
    <td><input type="button" value="鎖定" onclick="press(this,'管理者停用')">
        <input type="button" value="啟用" onclick="press(this,'正常')"></td></tr>
  <tr><td>2</td><td>DEV-B</td><td>中路92</td><td>tyfd02</td><td>正常</td><td>2026/10/29 08:00</td>
    <td><input type="button" value="鎖定" onclick="press(this,'管理者停用')">
        <input type="button" value="停用" onclick="press(this,'誘餌')"></td></tr>
  <tr><td>3</td><td>DEV-C</td><td>埔心91</td><td>tyfd03</td><td>持續取得資料</td><td>2026/10/29 08:00</td>
    <td><input type="button" value="鎖定" onclick="press(this,'管理者停用')"></td></tr>
  <tr><td>3</td><td>DEV-C</td><td>埔心91</td><td>tyfd03</td><td>持續取得資料</td><td>2026/10/29 08:05</td>
    <td><input type="button" value="鎖定" onclick="press(this,'管理者停用')"></td></tr>
  <tr><td colspan="7">共 4 筆</td></tr>
</table>`;

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
const frame = page?.mainFrame() ?? null;
const skip = browser ? false : '本機找不到 Chrome 或 Edge，略過 DOM 測試';

test.after(async () => {
  await browser?.close();
});

/** 每個測試都從乾淨的假頁面開始，按過的鈕不會影響下一個。 */
async function freshPage() {
  await page.setContent(FIXTURE);
}

const { statusColumns, labelColumns, volatileHeaderKeywords, buttonTexts, statusValues } = UNLOCK.deviceReset;
const query = { statusColumns, labelColumns, volatileHeaderKeywords, buttonTexts };

test('裝置清單：讀得出每一列的狀態、車輛與同列按鈕，跨欄的總計列不算', { skip }, async () => {
  await freshPage();
  const scan = await findStatusRows(frame, query);
  assert.equal(scan.found, true);
  assert.equal(scan.rows.length, 4);
  const [first, second] = scan.rows;
  assert.equal(first.status, '持續取得資料');
  assert.equal(first.label, '桃園91');
  assert.deepEqual(first.buttons, { lock: true, enable: true });
  assert.deepEqual(second.buttons, { lock: true, enable: false }, '「停用」不可以被當成「啟用」');
});

test('裝置清單：帳號與裝置ID 原文不帶出頁面，只有短碼', { skip }, async () => {
  await freshPage();
  const scan = await findStatusRows(frame, query);
  const dumped = JSON.stringify(scan.rows);
  assert.ok(!dumped.includes('tyfd01'), '使用者帳號不可以外流');
  assert.ok(!dumped.includes('DEV-A'), '裝置ID 不可以外流');
});

test('裝置清單：兩列只差在時間欄時視為認不出，標成不唯一', { skip }, async () => {
  await freshPage();
  const scan = await findStatusRows(frame, query);
  assert.equal(scan.rows[0].unique, true);
  assert.equal(scan.rows[2].unique, false);
  assert.equal(scan.rows[3].unique, false);
});

test('裝置清單：鎖定後時間變了仍找得回同一列，接著按得下啟用', { skip }, async () => {
  await freshPage();
  const before = (await findStatusRows(frame, query)).rows[0];
  const locked = await clickStatusRowButton(frame, {
    ...query, fingerprint: before.fingerprint, expectedStatus: statusValues.stuck, buttonKey: 'lock',
  });
  assert.equal(locked.clicked, true);
  const afterLock = (await findStatusRows(frame, query)).rows.find((row) => row.fingerprint === before.fingerprint);
  assert.ok(afterLock, '時間欄變了也要找得回來');
  assert.equal(afterLock.status, '管理者停用');

  const enabled = await clickStatusRowButton(frame, {
    ...query, fingerprint: before.fingerprint, expectedStatus: statusValues.disabled, buttonKey: 'enable',
  });
  assert.equal(enabled.clicked, true);
  assert.deepEqual(await frame.evaluate(() => window.__clicks), ['DEV-A:管理者停用', 'DEV-A:正常']);
});

test('裝置清單：狀態已經不是預期的就不按', { skip }, async () => {
  await freshPage();
  const normalRow = (await findStatusRows(frame, query)).rows[1];
  const result = await clickStatusRowButton(frame, {
    ...query, fingerprint: normalRow.fingerprint, expectedStatus: statusValues.stuck, buttonKey: 'lock',
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'statusChanged');
  assert.deepEqual(await frame.evaluate(() => window.__clicks), []);
});

test('裝置清單：短碼對到兩列時一個都不按', { skip }, async () => {
  await freshPage();
  const duplicated = (await findStatusRows(frame, query)).rows[2];
  const result = await clickStatusRowButton(frame, {
    ...query, fingerprint: duplicated.fingerprint, expectedStatus: statusValues.stuck, buttonKey: 'lock',
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'notUnique');
  assert.deepEqual(await frame.evaluate(() => window.__clicks), []);
});

test('裝置清單：那一列沒有要按的鈕時不按，不去抓別列的', { skip }, async () => {
  await freshPage();
  const normalRow = (await findStatusRows(frame, query)).rows[1];
  const result = await clickStatusRowButton(frame, {
    ...query, fingerprint: normalRow.fingerprint, expectedStatus: ['正常'], buttonKey: 'enable',
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'noButton');
});

test('裝置清單：找不到狀態欄時回報版面欄位，不當成「沒有卡住的裝置」', { skip }, async () => {
  await freshPage();
  const scan = await findStatusRows(frame, { ...query, statusColumns: ['不存在的欄'] });
  assert.equal(scan.found, false);
  assert.ok(scan.tableHeaders.some((headers) => headers.includes('狀態')), '要列出實際有哪些欄');
});
