/**
 * 解鎖前後紀錄表比對的測試（純函式，不開瀏覽器）。
 *
 * 最要緊的是兩件事：
 *   1. 比得出哪裡不同、說得出是哪一欄
 *   2. **雲端版絕不帶出病患資料**：姓名、身分證只能寫「更正「姓名」」，
 *      就算欄位切錯了，姓名也過不了「只有數字／時間」的樣式檢查
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNLOCK } from './config.mjs';
import {
  describeChanges,
  diffLines,
  findLabels,
  formatLocalReport,
  splitByLabels,
  toCloudItems,
  toSheetLines,
} from './sheetDiff.mjs';

const CONFIG = UNLOCK.revision;

test('切行時去掉空行、整理空白，並忽略列印時間與頁碼', () => {
  const lines = toSheetLines('姓名  王小明\n\n列印時間 2026/11/03 10:00\n第 1 頁\n1/2 頁\n  血壓 120/80 ', CONFIG.ignoreLinePatterns);
  assert.deepEqual(lines, ['姓名 王小明', '血壓 120/80']);
});

test('只有數字的血壓行（120/80）不可以被當成頁碼丟掉', () => {
  assert.deepEqual(toSheetLines('120/80', CONFIG.ignoreLinePatterns), ['120/80']);
});

test('逐行比對：只有中間改了一行時，前後都是相同', () => {
  const ops = diffLines(['甲', '乙', '丙'], ['甲', '乙改', '丙']);
  assert.deepEqual(ops.map((op) => op.type), ['same', 'removed', 'added', 'same']);
});

test('空白多寡不算改動（PDF 每次抽出來的空白不一定一樣）', () => {
  const changes = describeChanges('到院時間 10:38\n血壓 120/80', '到院時間  10:38\n血壓 120 / 80', CONFIG);
  assert.equal(changes.length, 0);
});

test('長的標籤優先：「到院前檢傷分級」不會被拆成「檢傷分級」', () => {
  const labels = findLabels('到院前檢傷分級 第二級', CONFIG.fieldLabels).map((hit) => hit.label);
  assert.deepEqual(labels, ['到院前檢傷分級']);
});

test('同一行好幾欄時，只算值真的變了的那一欄', () => {
  const changes = describeChanges('姓名 王小明 性別 男 年齡 45', '姓名 王小明 性別 男 年齡 46', CONFIG);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].fields, ['年齡']);
  assert.equal(changes[0].fieldSource, 'inline');
});

test('值跟標籤分在不同行時，往上找最近的標籤行（只能說「附近」）', () => {
  const before = '姓名 性別\n王小明 男\n血壓\n120/80';
  const after = '姓名 性別\n王大明 男\n血壓\n120/80';
  const changes = describeChanges(before, after, CONFIG);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].fieldSource, 'nearby');
  assert.deepEqual(changes[0].fields, ['姓名', '性別']);
});

test('找不到任何標籤時寫「未能判斷欄位」，不硬猜', () => {
  const changes = describeChanges('甲乙丙', '甲乙丁', CONFIG);
  assert.equal(changes[0].fieldSource, 'unknown');
  const cloud = toCloudItems(changes, CONFIG);
  assert.match(cloud.items[0], /未能判斷/);
});

test('雲端版：改了姓名、身分證只寫欄位名，不寫內容', () => {
  const changes = describeChanges(
    '姓名 王小明\n身分證字號 A123456789',
    '姓名 王大明\n身分證字號 A123456780',
    CONFIG,
  );
  const cloud = toCloudItems(changes, CONFIG);
  const joined = cloud.items.join('｜');
  assert.match(joined, /更正「姓名」/);
  assert.match(joined, /更正「身分證字號」/);
  assert.doesNotMatch(joined, /王/);
  assert.doesNotMatch(joined, /A12345/);
});

test('雲端版：時間、生命徵象這類白名單欄位可以寫出改前改後', () => {
  const changes = describeChanges('到院時間 10:38\n血壓 120/80', '到院時間 10:45\n血壓 130/85', CONFIG);
  const cloud = toCloudItems(changes, CONFIG);
  const joined = cloud.items.join('｜');
  assert.match(joined, /「到院時間」10:38 → 10:45/);
  assert.match(joined, /「血壓」120\/80 → 130\/85/);
});

test('雲端版：白名單欄位的值看起來不像數字（切錯段把姓名吃進來）時，退回只寫欄位名', () => {
  const changes = describeChanges('到院時間 10:38 王小明', '到院時間 10:45 王小明', CONFIG);
  const cloud = toCloudItems(changes, CONFIG);
  assert.equal(cloud.items[0], '更正「到院時間」');
});

test('雲端版：同一處碰到個資欄位，整處都不寫內容（就算另一欄在白名單裡）', () => {
  const changes = describeChanges('姓名 王小明 到院時間 10:38', '姓名 王大明 到院時間 10:45', CONFIG);
  const joined = toCloudItems(changes, CONFIG).items.join('｜');
  assert.doesNotMatch(joined, /10:38|10:45|王/);
  assert.match(joined, /更正「姓名」/);
  assert.match(joined, /更正「到院時間」/);
});

test('雲端版：附近推測出來的欄位一律只寫欄位名', () => {
  const changes = describeChanges('血壓\n120/80', '血壓\n130/85', CONFIG);
  const cloud = toCloudItems(changes, CONFIG);
  assert.equal(cloud.items[0], '「血壓」附近的內容有更動');
});

test('雲端版：太多項時只列前幾項，其餘寫「另有 N 項」', () => {
  // 20 個不同的欄位各改一處（中間夾一行相同的，才不會合成同一處）。
  const labels = Array.from({ length: 20 }, (_value, index) => `欄${index}號`);
  const config = { ...CONFIG, fieldLabels: labels, cloudMaxItems: 5 };
  const build = (value) => labels.flatMap((label) => [`${label} ${value}`, '相同的一行']).join('\n');
  const changes = describeChanges(build('甲'), build('乙'), config);
  const cloud = toCloudItems(changes, config);
  assert.equal(cloud.items.length, 5);
  assert.match(cloud.items[4], /另有 16 項/);
  assert.equal(cloud.changeCount, 20);
});

test('雲端版：判斷不出欄位的幾處合成一句「有 N 處」', () => {
  const changes = describeChanges('甲\n相同\n乙', '丙\n相同\n丁', CONFIG);
  assert.deepEqual(toCloudItems(changes, CONFIG).items, ['有 2 處內容不同（未能判斷是哪一欄，詳見本機報告）']);
});

test('依標籤切段：第一個標籤之前的文字放在 prefix', () => {
  const result = splitByLabels('桃園市政府 姓名 王小明 性別 男', CONFIG.fieldLabels);
  assert.equal(result.prefix, '桃園市政府');
  assert.equal(result.values.get('姓名'), '王小明');
  assert.equal(result.values.get('性別'), '男');
});

test('本機報告：沒有不同時明講內容相同；有不同時逐條列出改前改後', () => {
  const meta = {
    temsis: '2026090710100307554102',
    caseDate: '2026/09/07 10:10',
    vehicle: '大湳93',
    squad: '大湳分隊',
    remark: '救護紀錄表內容-v1',
    unlockedAt: '2026-11-03T02:00:00.000Z',
    comparedAt: '2026-11-04T02:00:00.000Z',
    backupFile: 'a-v1-解鎖前.pdf',
    closedFile: 'a-v1-結案後.pdf',
  };
  assert.match(formatLocalReport(meta, [], CONFIG), /兩份內容相同/);
  const changes = describeChanges('姓名 王小明', '姓名 王大明', CONFIG);
  const report = formatLocalReport(meta, changes, CONFIG);
  assert.match(report, /共 1 處不同/);
  assert.match(report, /姓名：「王小明」→「王大明」/);
  assert.match(report, /請勿外傳/);
});
