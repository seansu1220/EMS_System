/**
 * 解鎖前後紀錄表比對的測試（純函式，不開瀏覽器）。
 *
 * 版面照 2026-11-03 實際取樣（`sheet-sample`，已遮蔽）的座標造：救護紀錄PDF(桃) **整頁轉 90 度**，
 * 文字前進方向是 (0,1)，所以 x 越大越下面、y 越大越右邊。值全部是假資料。
 *
 * 最要緊的是：
 *   1. 說得出是哪一欄（同一列前面的標籤、上方表頭）
 *   2. **雲端版絕不帶出病患資料**：姓名、身分證只寫欄位名；勾選框只有已知區塊（印好的選項）才寫選項；
 *      沒改過的姓名也不可以被當成標籤
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNLOCK } from './config.mjs';
import {
  describeCheckboxEdits,
  parseCheckboxes,
  describeChanges,
  formatLocalReport,
  isLoneCheckbox,
  toCloudItems,
  toReadingFrame,
} from './sheetDiff.mjs';

const CONFIG = UNLOCK.revision;

/** 轉 90 度頁面上的一段文字（跟實際紀錄表一樣）。 */
const at = (x, y, str) => ({ page: 1, x, y, width: 10, height: 8, str, hasEOL: false, dirX: 0, dirY: 1 });

/** 實際紀錄表上的幾個標籤（位置取自取樣）。 */
const LABELS = [
  at(154, 19, '傷病患姓名'),
  at(154, 157, '性別'),
  at(173, 11, '國民身分證統一編號'),
  at(179, 11, '/外籍患者護照號碼'),
  at(177, 157, '年齡'),
  at(65, 134, '到達現場時間'),
  at(403, 732, 'SpO2'),
  at(403, 490, '意識狀況'),
  at(92, 16, '發生地點'),
];

/** 組一份紀錄表：標籤＋各格的值。 */
const sheet = (values) => [...LABELS, ...values];

const MEAN_NAME = '王小明';

test('閱讀座標：轉 90 度的頁面 row＝x、col＝y；一般橫書 row＝-y、col＝x', () => {
  assert.deepEqual(toReadingFrame(at(154, 19, '')), { row: 154, col: 19 });
  assert.deepEqual(toReadingFrame({ x: 30, y: 700, dirX: 1, dirY: 0 }), { row: -700, col: 30 });
});

test('勾選框：認得單獨的記號，也拆得出選項文字', () => {
  assert.equal(isLoneCheckbox(' ■ '), true);
  assert.equal(isLoneCheckbox('■ 保暖'), false);
  assert.deepEqual(parseCheckboxes('■ 保暖'), [{ checked: true, option: '保暖' }]);
  assert.deepEqual(parseCheckboxes('保暖'), []);
});

test('兩份一模一樣時沒有不同', () => {
  const items = sheet([at(155, 95, MEAN_NAME)]);
  assert.deepEqual(describeChanges(items, items, CONFIG), []);
});

test('改姓名：歸到同一列前面的「傷病患姓名」，雲端只寫欄位名', () => {
  const changes = describeChanges(sheet([at(155, 95, MEAN_NAME)]), sheet([at(155, 95, '王大明')]), CONFIG);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].fields, ['傷病患姓名']);
  assert.equal(changes[0].fieldSource, 'inline');
  const joined = toCloudItems(changes, CONFIG).items.join('｜');
  assert.equal(joined, '更正「傷病患姓名」');
});

test('改身分證：歸到身分證那一列的標籤，雲端看不到號碼', () => {
  const changes = describeChanges(sheet([at(177, 91, 'A123456789')]), sheet([at(177, 91, 'A123456780')]), CONFIG);
  const joined = toCloudItems(changes, CONFIG).items.join('｜');
  assert.match(joined, /更正「(國民身分證統一編號|\/外籍患者護照號碼)」/);
  assert.doesNotMatch(joined, /A12345/);
});

test('改時間：值在表頭「到達現場時間」正下方，白名單欄位寫得出改前改後', () => {
  const changes = describeChanges(sheet([at(76, 134, '10-27 08:10')]), sheet([at(76, 134, '10-27 08:15')]), CONFIG);
  assert.deepEqual(changes[0].fields, ['到達現場時間']);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['「到達現場時間」10-27 08:10 → 10-27 08:15']);
});

test('生命徵象第三欄（離表頭最遠）也認得到 SpO2', () => {
  const before = sheet([at(420, 732, '96%'), at(441, 732, '97%'), at(464, 732, '95%')]);
  const after = sheet([at(420, 732, '96%'), at(441, 732, '97%'), at(464, 732, '98%')]);
  assert.deepEqual(toCloudItems(describeChanges(before, after, CONFIG), CONFIG).items, ['「SpO2」95% → 98%']);
});

test('勾選框（選項在同一段）：寫得出區塊、選項與勾選', () => {
  const changes = describeChanges(sheet([at(280, 517, '□ 保暖')]), sheet([at(280, 517, '■ 保暖')]), CONFIG);
  assert.equal(changes[0].kind, 'checkbox');
  assert.equal(changes[0].option, '保暖');
  assert.equal(changes[0].checkAction, 'checked');
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['「其他處置」勾選「保暖」']);
  const report = formatLocalReport({
    temsis: 'T', caseDate: null, vehicle: null, squad: null, remark: 'v1',
    unlockedAt: 'a', comparedAt: 'b', backupFile: 'x', closedFile: 'y',
  }, changes, CONFIG);
  assert.match(report, /〔其他處置〕勾選「保暖」/);
  assert.match(report, /解鎖前：□ 保暖/);
});

test('單獨的勾選框：選項取旁邊那個字，同名選項依位置分區塊', () => {
  const before = sheet([at(364, 306, '□'), at(364, 311, '糖尿病')]);
  const after = sheet([at(364, 306, '■'), at(364, 311, '糖尿病')]);
  const changes = describeChanges(before, after, CONFIG);
  assert.equal(changes[0].option, '糖尿病');
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['「過去病史」勾選「糖尿病」']);
  // 「到院前心肺功能停止」非創傷、創傷各有一個（位置取自實際紀錄表）
  const ohca = (col, mark) => [at(294, col, mark), at(295, col + 7, '到院前心肺功能停止')];
  const nonTrauma = describeChanges(ohca(127, '■'), ohca(127, '□'), CONFIG);
  assert.deepEqual(toCloudItems(nonTrauma, CONFIG).items, ['「非創傷」取消勾選「到院前心肺功能停止」']);
  const trauma = describeChanges(ohca(326, '□'), ohca(326, '■'), CONFIG);
  assert.deepEqual(toCloudItems(trauma, CONFIG).items, ['「創傷」勾選「到院前心肺功能停止」']);
});

test('同一列離太遠的別區標籤不算（救護人員簽名不可以歸到「最後正常時間」）', () => {
  const labels = [at(521, 334, '最後正常時間'), at(482, 469, '救護人員簽名')];
  const changes = describeChanges([...labels, at(521, 472, '甲')], [...labels, at(521, 472, '乙')], CONFIG);
  assert.deepEqual(changes[0].fields, ['救護人員簽名']);
});

test('沒改過的姓名絕不可以被當成標籤（不然會被寫上雲端）', () => {
  // 旁邊只有沒改過的姓名、沒有任何設定檔裡的標籤時，寧可說判斷不出來。
  const before = [at(300, 300, MEAN_NAME), at(300, 320, '甲')];
  const after = [at(300, 300, MEAN_NAME), at(300, 320, '乙')];
  const changes = describeChanges(before, after, CONFIG);
  assert.equal(changes[0].fieldSource, 'unknown');
  const joined = toCloudItems(changes, CONFIG).items.join('｜');
  assert.doesNotMatch(joined, /王/);
  assert.match(joined, /有 1 處內容不同/);
});

test('同一欄拆成好幾段（地址）合成一處', () => {
  const before = sheet([at(92, 47, '桃園市桃園區'), at(92, 90, '中正路1號')]);
  const after = sheet([at(92, 47, '桃園市中壢區'), at(92, 90, '中央路2號')]);
  const changes = describeChanges(before, after, CONFIG);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].fields, ['發生地點']);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['更正「發生地點」']);
});

test('新增與刪除的格子也算不同', () => {
  const changes = describeChanges(sheet([]), sheet([at(155, 95, MEAN_NAME)]), CONFIG);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].before, ['']);
  assert.deepEqual(changes[0].after, [MEAN_NAME]);
});

test('白名單欄位的值不像數字時退回只寫欄位名（最後一道防線）', () => {
  const changes = describeChanges(sheet([at(76, 134, '10-27 08:10')]), sheet([at(76, 134, MEAN_NAME)]), CONFIG);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['更正「到達現場時間」']);
});

test('太多項時只列前幾項，其餘寫「另有 N 項」', () => {
  const labels = Array.from({ length: 20 }, (_value, index) => at(30 + index * 20, 10, `欄${index}號`));
  const build = (value) => [...labels, ...labels.map((label) => at(label.x, 60, value))];
  const config = { ...CONFIG, layoutLabels: labels.map((label) => label.str), cloudMaxItems: 5 };
  const cloud = toCloudItems(describeChanges(build('甲'), build('乙'), config), config);
  assert.equal(cloud.items.length, 5);
  assert.match(cloud.items[4], /另有 16 項/);
  assert.equal(cloud.changeCount, 20);
});

test('本機報告：沒有不同時明講內容相同；有不同時列出改前改後與欄位', () => {
  const meta = {
    temsis: '2026090710100307554102', caseDate: '2026/09/07 10:10', vehicle: '大湳93', squad: '大湳分隊',
    remark: '救護紀錄表內容-v1', unlockedAt: '2026-11-03T02:00:00.000Z', comparedAt: '2026-11-04T02:00:00.000Z',
    backupFile: 'a-v1-解鎖前.pdf', closedFile: 'a-v1-結案後.pdf',
  };
  assert.match(formatLocalReport(meta, [], CONFIG), /兩份內容相同/);
  const changes = describeChanges(sheet([at(155, 95, MEAN_NAME)]), sheet([at(155, 95, '王大明')]), CONFIG);
  const report = formatLocalReport(meta, changes, CONFIG);
  assert.match(report, /共 1 處不同/);
  assert.match(report, /〔傷病患姓名〕/);
  assert.match(report, /解鎖前：王小明/);
  assert.match(report, /結案後：王大明/);
  assert.match(report, /請勿外傳/);
});

test('補述欄的內容（標籤下方偏左一整塊）歸到「補述欄」', () => {
  const label = at(170, 716, '補述欄');
  const changes = describeChanges([label, at(179, 632, '原本的補述')], [label, at(179, 632, '改過的補述')], CONFIG);
  assert.deepEqual(changes[0].fields, ['補述欄']);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['更正「補述欄」']);
});

test('GCS 的 M 分數：標籤顯示成 GCS-M，數值寫得出改前改後', () => {
  const labels = [at(403, 682, 'GCS'), at(420, 699, 'M')];
  const changes = describeChanges([...labels, at(420, 712, '5')], [...labels, at(420, 712, '6')], CONFIG);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['「GCS-M」5 → 6']);
});

/** 生命徵象表：表頭（列 403）＋三個時間點標籤（印在每一格最下面，位置取自 2026110610100310422401）。 */
const VITALS = [
  at(403, 451, '時間'), at(403, 490, '意識狀況'), at(403, 682, 'GCS'), at(403, 732, 'SpO2'),
  at(424.4, 450, '現場'), at(446.4, 442, '送醫途中'), at(469.4, 446, '到院後'),
];

test('生命徵象的量測時間：時間在時間點標籤上方，11:31 屬於「到院後」不是「送醫途中」', () => {
  const build = (third) => [...VITALS, at(414.4, 448, '10:50'), at(436.4, 448, '11:10'), at(459.4, 448, third)];
  const changes = describeChanges(build('10:50'), build('11:31'), CONFIG);
  assert.deepEqual(changes[0].fields, ['生命徵象（到院後）量測時間']);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['「生命徵象（到院後）量測時間」10:50 → 11:31']);
});

test('生命徵象各時間點分開列：抵達現場、送醫途中的 GCS 各寫一項', () => {
  const build = (value) => [...VITALS, at(420.4, 653, 'E'), at(420.4, 663.5, value), at(441.4, 653, 'E'), at(441.4, 663.5, value)];
  const changes = describeChanges(build('4'), build('1'), CONFIG);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, [
    '「生命徵象（抵達現場）GCS-E」4 → 1',
    '「生命徵象（送醫途中）GCS-E」4 → 1',
  ]);
});

test('生命徵象的意識狀況勾選：寫得出時間點、欄位與取消勾選', () => {
  const build = (mark) => [...VITALS, at(435.5, 486.5, mark), at(436.4, 493, '清')];
  const changes = describeChanges(build('■'), build('□'), CONFIG);
  assert.equal(changes[0].kind, 'checkbox');
  assert.deepEqual(changes[0].fields, ['生命徵象（送醫途中）意識狀況']);
  assert.equal(changes[0].option, '清');
  const cloud = toCloudItems(changes, CONFIG).items;
  assert.deepEqual(cloud, ['「生命徵象（送醫途中）意識狀況」取消勾選「清」']);
});

test('受傷部位說明（人形圖旁一行一行往下排）合成一處「受傷部位及尺寸」，雲端只寫欄位名', () => {
  const label = at(55.4, 666.5, '請在圖上標示說明受傷部位及其尺寸');
  const before = [label, at(64.6, 732, '1:肢體，擦傷，3公分。2:背'), at(71.6, 732, '，擦傷，5公分。')];
  const after = [label, at(64.6, 732, '1:肢體，擦傷，3公分。2:腹'), at(71.6, 732, '，右腹，擦傷，3公分。'), at(78.6, 732, '3:手心')];
  const changes = describeChanges(before, after, CONFIG);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].fields, ['受傷部位及尺寸']);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['更正「受傷部位及尺寸」']);
});

test('長標籤後面接的值（從標籤結尾量）：指派案號認得到', () => {
  const label = { ...at(15.2, 625, '救災救護指揮中心指派案號:'), width: 112.5 };
  const changes = describeChanges([label, at(15.2, 745, '20261104180923003')], [label, at(15.2, 745, '20261104180923004')], CONFIG);
  assert.deepEqual(changes[0].fields, ['救災救護指揮中心指派案號']);
});

test('勾選框解析：一段裡好幾個框、記號前的標題不算、成對的括號保留', () => {
  assert.deepEqual(parseCheckboxes('目擊者: □ 有'), [{ checked: false, option: '有' }]);
  assert.deepEqual(parseCheckboxes('□ 不識字 ■ 拒簽'), [{ checked: false, option: '不識字' }, { checked: true, option: '拒簽' }]);
  assert.deepEqual(parseCheckboxes('□ BVM(正壓輔助呼吸)'), [{ checked: false, option: 'BVM(正壓輔助呼吸)' }]);
  assert.equal(describeCheckboxEdits('□ 不識字 □ 拒簽', '□ 不識字 ■ 拒簽')[0].option, '拒簽');
  assert.equal(describeCheckboxEdits('■', '□')[0].action, 'unchecked');
  assert.equal(describeCheckboxEdits('', '■ 保暖')[0].action, 'checked');
});

test('一段裡兩個框同時改：兩筆都列出來', () => {
  const edits = describeCheckboxEdits('■ 不識字 □ 拒簽', '□ 不識字 ■ 拒簽');
  assert.deepEqual(edits.map((edit) => [edit.option, edit.action]), [['不識字', 'unchecked'], ['拒簽', 'checked']]);
  const changes = describeChanges([at(562, 736, '■ 不識字 □ 拒簽')], [at(562, 736, '□ 不識字 ■ 拒簽')], CONFIG);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['「無法簽名原因」取消勾選「不識字」', '「無法簽名原因」勾選「拒簽」']);
});

test('框數不同時依選項名稱配對，不會指錯選項', () => {
  const edits = describeCheckboxEdits('□ 不識字', '□ 不識字 ■ 拒簽');
  assert.deepEqual(edits.map((edit) => [edit.option, edit.action, edit.optionStable]), [['拒簽', 'checked', false]]);
});

test('勾選沒變、只有字變了：雲端絕不寫出那段字', () => {
  const changes = describeChanges([at(574, 709, '□ 其他：王小明')], [at(574, 709, '□ 其他：李大華')], CONFIG);
  assert.equal(changes[0].option, null);
  const cloud = toCloudItems(changes, CONFIG).items.join('｜');
  assert.doesNotMatch(cloud, /王|李/);
  assert.equal(cloud, '「無法簽名原因」勾選有更動');
});

test('單獨的框旁邊那段字兩份不一樣時，雲端不寫選項', () => {
  const changes = describeChanges([at(364, 306, '□'), at(364, 311, '糖尿病')], [at(364, 306, '■'), at(364, 311, '王小明')], CONFIG);
  const cloud = toCloudItems(changes, CONFIG).items.join('｜');
  assert.doesNotMatch(cloud, /王/);
  assert.match(cloud, /「過去病史」勾選有更動/);
});

test('傷病患住址的「同發生地點」也寫得出選項（使用者 2026-11-07：所有選項都可以顯示）', () => {
  const build = (mark) => [at(194, 373, `${mark} 同發生地點`)];
  const changes = describeChanges(build('□'), build('■'), CONFIG);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['「傷病患住址」勾選「同發生地點」']);
});

test('勾選框旁邊的手寫內容就算兩份一樣也不上雲（只寫得出表上印好的選項）', () => {
  // 同一段：記號後面接手寫內容，勾選變了、字沒變
  const inline = describeChanges([at(574, 709, '□ 其他：王小明')], [at(574, 709, '■ 其他：王小明')], CONFIG);
  assert.equal(inline[0].optionVerified, true);
  assert.deepEqual(toCloudItems(inline, CONFIG).items, ['「無法簽名原因」勾選有更動']);
  // 單獨一個框：藥物處置的空白框（實際位置 列 161、欄 528），旁邊手打的字兩份一樣
  const lone = (mark) => [at(161, 528, mark), at(162, 536, '王小明')];
  const changes = describeChanges(lone('□'), lone('■'), CONFIG);
  const cloud = toCloudItems(changes, CONFIG).items.join('｜');
  assert.doesNotMatch(cloud, /王/);
  assert.equal(cloud, '「藥物處置：靜脈輸液」勾選有更動');
});

test('靜脈輸液、骨針兩列的同名選項分得開', () => {
  const box = (row, mark) => [at(row, 528, `${mark} 0.9%N/S`)];
  const iv = describeChanges(box(139, '□'), box(139, '■'), CONFIG);
  const bone = describeChanges(box(182, '□'), box(182, '■'), CONFIG);
  assert.deepEqual(toCloudItems(iv, CONFIG).items, ['「藥物處置：靜脈輸液」勾選「0.9%N/S」']);
  assert.deepEqual(toCloudItems(bone, CONFIG).items, ['「藥物處置：骨針」勾選「0.9%N/S」']);
});

test('SpO2、血糖值在 GCS 的 M 右邊同一列，不可以算成 GCS-M（實際版面 M 在欄 699）', () => {
  const labels = [...VITALS, at(403, 763, '血糖值'), { ...at(420.4, 699, 'M'), width: 4 }];
  const build = (gcs, spo2, sugar) => [...labels, at(420.4, 709.5, gcs), at(420.4, 732, spo2), at(420.4, 755.5, sugar)];
  const changes = describeChanges(build('5', '96%', '102mg/dl'), build('6', '98%', '110mg/dl'), CONFIG);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, [
    '「生命徵象（抵達現場）GCS-M」5 → 6',
    '「生命徵象（抵達現場）SpO2」96% → 98%',
    '「生命徵象（抵達現場）血糖值」102mg/dl → 110mg/dl',
  ]);
});

test('已知區塊外的勾選框：雲端不寫選項（旁邊可能是手寫內容）', () => {
  const build = (mark) => [at(700, 700, mark), at(700, 707, '王小明')];
  const changes = describeChanges(build('□'), build('■'), CONFIG);
  assert.deepEqual(changes[0].fields, []);
  const cloud = toCloudItems(changes, CONFIG).items.join('｜');
  assert.doesNotMatch(cloud, /王/);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['有 1 個勾選項目有更動（勾了哪些詳見本機報告）']);
});
