/**
 * 裝置管理清單的 DOM 測試：用一張**自己造的假頁面**，在真的瀏覽器裡驗證
 * `pageFinder.mjs` 的 `statusRows`／`clickStatusRow` 找得對、按得對。
 *
 * 假頁面照 2026-10-29 探測到的版面：欄位相同、每列只有一顆會切換的鈕
 * （正常的是「鎖定」、停用的是「啟用」，id 每列都一樣）、鈕的 onclick 自帶裝置ID、
 * 「使用者」欄是「分隊/姓名」。按下去會像真系統一樣改掉狀態、異常狀態與錯誤次數。
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

/** 一列假資料；`buttonId` 可以故意給錯，模擬「按鈕跟所在列對不起來」。 */
function deviceRow({ user, deviceId, status, buttonId = deviceId }) {
  const isDisabled = status === '管理者停用';
  return `<tr><td>1</td><td>${user}</td><td>車輛模式</td><td>6991</td><td>${status}</td>
    <td>2025/08/14</td><td>${deviceId}</td><td>0</td><td>1.2</td><td>無異常</td><td>2026/10/29 08:00:00</td><td></td>
    <td><input type="button" id="${isDisabled ? '_btnUnlock' : '_btnLock'}" value="${isDisabled ? '啟用' : '鎖定'}"
      onclick="javascript:press(this,'wap119.RPS64301010','${buttonId}');">
      <input type="button" id="_btnChoose" value="修改"></td></tr>`;
}

const FIXTURE = `
<script>
  window.__clicks = [];
  function press(button, ap, deviceId) {
    const row = button.closest('tr');
    const locking = button.value === '鎖定';
    window.__clicks.push(deviceId + ':' + button.value);
    row.cells[4].textContent = locking ? '管理者停用' : '已啟用';
    row.cells[7].textContent = String(Number(row.cells[7].textContent) + 1); // 錯誤次數跟著變
    row.cells[9].textContent = locking ? '停用中' : '無異常';
    row.cells[10].textContent = '2026/10/29 09:00:00';
    button.value = locking ? '啟用' : '鎖定';
    button.id = locking ? '_btnUnlock' : '_btnLock';
  }
</script>
<table id="table1"><tr><th>關鍵字(使用者、裝置描述、裝置ID)</th><th>欄位隱藏</th></tr><tr><td></td><td></td></tr></table>
<table id="table1">
  <tr><th>項目</th><th>使用者</th><th>裝置描述</th><th>裝置種類</th><th>狀態</th><th>申請日期</th><th>裝置ID</th>
    <th>錯誤次數</th><th>版本</th><th>異常狀態</th><th>最後登入時間</th><th>備註</th><th></th></tr>
  ${deviceRow({ user: '中路分隊/王小明', deviceId: '10B23B5D-A0AA-4E25-B988-D56E2E2D3B12', status: '持續取得資料' })}
  ${deviceRow({ user: '大園分隊/陳大華', deviceId: 'D8:68:C3:13:62:35', status: '已啟用' })}
  ${deviceRow({ user: '埔心分隊/林一二', deviceId: '7ca6ceeb292a3ebe', status: '管理者停用' })}
  ${deviceRow({ user: '平鎮分隊/張三四', deviceId: 'AAAA-1111', status: '持續取得資料', buttonId: 'BBBB-2222' })}
  ${deviceRow({ user: '楊梅分隊/李五六', deviceId: 'DUP-0001', status: '持續取得資料' })}
  ${deviceRow({ user: '楊梅分隊/李五六', deviceId: 'DUP-0001', status: '持續取得資料' })}
  ${deviceRow({ user: '沒有分隊的名字', deviceId: 'CCCC-3333', status: '已啟用' })}
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

const {
  statusColumns, identityColumns, labelColumns, labelSeparator,
  volatileHeaderKeywords, buttonTexts, statusValues,
} = UNLOCK.deviceReset;
const query = { statusColumns, identityColumns, labelColumns, labelSeparator, volatileHeaderKeywords, buttonTexts };

/** 用來按某一列的參數。 */
function pressOptions(row, buttonKey, expectedStatus) {
  return { ...query, fingerprint: row.fingerprint, expectedStatus, buttonKey };
}

test('裝置清單：讀得出狀態、分隊、裝置ID 末 4 碼與同列的鈕，上面的關鍵字表不算', { skip }, async () => {
  await freshPage();
  const scan = await findStatusRows(frame, query);
  assert.equal(scan.found, true);
  assert.equal(scan.rows.length, 7);
  const [first, second, third] = scan.rows;
  assert.equal(first.status, '持續取得資料');
  assert.equal(first.label, '中路分隊');
  assert.equal(first.idTail, '3B12');
  assert.deepEqual(first.buttons, { lock: true, enable: false });
  assert.deepEqual(second.buttons, { lock: true, enable: false });
  assert.deepEqual(third.buttons, { lock: false, enable: true }, '停用中的列只有啟用鈕');
});

test('裝置清單：使用者姓名與完整裝置ID 不帶出頁面', { skip }, async () => {
  await freshPage();
  const dumped = JSON.stringify((await findStatusRows(frame, query)).rows);
  for (const secret of ['王小明', '陳大華', '10B23B5D', 'D8:68']) {
    assert.ok(!dumped.includes(secret), `${secret} 不可以外流`);
  }
  assert.equal((await findStatusRows(frame, query)).rows[6].label, null, '沒有分隔符號的值整個不取（可能是姓名）');
});

test('裝置清單：裝置ID 重複的兩列標成不唯一', { skip }, async () => {
  await freshPage();
  const { rows } = await findStatusRows(frame, query);
  assert.equal(rows[0].unique, true);
  assert.equal(rows[4].unique, false);
  assert.equal(rows[5].unique, false);
});

test('裝置清單：按鈕帶的裝置ID 跟所在列對不起來時，視為那一列沒有鈕', { skip }, async () => {
  await freshPage();
  const mismatched = (await findStatusRows(frame, query)).rows[3];
  assert.equal(mismatched.buttons.lock, false);
  const result = await clickStatusRowButton(frame, pressOptions(mismatched, 'lock', statusValues.stuck));
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'noButton');
  assert.deepEqual(await frame.evaluate(() => window.__clicks), []);
});

test('裝置清單：鎖定後異常狀態、錯誤次數、時間都變了，仍靠裝置ID 找回同一列並按得下啟用', { skip }, async () => {
  await freshPage();
  const before = (await findStatusRows(frame, query)).rows[0];
  assert.equal((await clickStatusRowButton(frame, pressOptions(before, 'lock', statusValues.stuck))).clicked, true);

  const afterLock = (await findStatusRows(frame, query)).rows.find((row) => row.fingerprint === before.fingerprint);
  assert.ok(afterLock, '其他欄位變了也要找得回來');
  assert.equal(afterLock.status, '管理者停用');
  assert.deepEqual(afterLock.buttons, { lock: false, enable: true }, '鈕已經切換成啟用');

  assert.equal((await clickStatusRowButton(frame, pressOptions(afterLock, 'enable', statusValues.disabled))).clicked, true);
  assert.deepEqual(await frame.evaluate(() => window.__clicks), [
    '10B23B5D-A0AA-4E25-B988-D56E2E2D3B12:鎖定',
    '10B23B5D-A0AA-4E25-B988-D56E2E2D3B12:啟用',
  ]);
});

test('裝置清單：狀態已經不是預期的就不按', { skip }, async () => {
  await freshPage();
  const normalRow = (await findStatusRows(frame, query)).rows[1];
  const result = await clickStatusRowButton(frame, pressOptions(normalRow, 'lock', statusValues.stuck));
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'statusChanged');
  assert.deepEqual(await frame.evaluate(() => window.__clicks), []);
});

test('裝置清單：裝置ID 對到兩列時一個都不按', { skip }, async () => {
  await freshPage();
  const duplicated = (await findStatusRows(frame, query)).rows[4];
  const result = await clickStatusRowButton(frame, pressOptions(duplicated, 'lock', statusValues.stuck));
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'notUnique');
  assert.deepEqual(await frame.evaluate(() => window.__clicks), []);
});

test('裝置清單：找不到裝置ID 欄時退回整列文字，只差在時間欄的兩列仍認得出是同一台', { skip }, async () => {
  await freshPage();
  const { rows } = await findStatusRows(frame, { ...query, identityColumns: ['不存在的欄'] });
  assert.equal(rows[0].unique, true);
  assert.equal(rows[0].idTail, null);
  assert.equal(rows[4].unique, false, '兩列除了時間欄都一樣，不可以當成唯一');
});

test('裝置清單：找不到狀態欄時回報版面欄位，不當成「沒有卡住的裝置」', { skip }, async () => {
  await freshPage();
  const scan = await findStatusRows(frame, { ...query, statusColumns: ['不存在的欄'] });
  assert.equal(scan.found, false);
  assert.ok(scan.tableHeaders.some((headers) => headers.includes('狀態')), '要列出實際有哪些欄');
});
