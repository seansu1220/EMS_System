/**
 * 逐字差異的測試（純函式；值全部是假資料）。
 *
 * 釘住的是：
 *   1. 只改一兩處時，寫得出「在哪裡、什麼改成什麼」，數字不會被切成兩半
 *   2. 只差空白（PDF 切段不同）不算改動
 *   3. 整段重寫時說「整段改寫」，不硬拆成一堆碎片；太長不比
 *   4. 短到一眼看得出、或有一邊是空的，不另外說明
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNLOCK } from './config.mjs';
import { describeTextDiff, diffText } from './textDiff.mjs';

const CONFIG = UNLOCK.revision.textDiff;

/** 比對後直接寫成句子。 */
const sentencesOf = (before, after, config = CONFIG) => describeTextDiff(diffText(before, after, config), config);

test('只改一個字：寫出前面沒變的字當位置，與什麼改成什麼', () => {
  assert.deepEqual(sentencesOf('車禍後左手擦傷疼痛', '車禍後右手擦傷疼痛'), ['在「車禍後」後面：「左」改成「右」']);
});

test('長文裡改了好幾處：一處一句，加上、改成都分得出', () => {
  const before = '患者自述騎機車自摔，左膝擦傷約3公分，意識清楚，生命徵象穩定';
  const after = '患者自述騎機車自摔，右膝擦傷約12公分，意識清楚，生命徵象穩定，拒絕送醫';
  const result = diffText(before, after, CONFIG);
  assert.equal(result.kind, 'edits');
  assert.equal(result.edits.length, 3);
  assert.deepEqual(describeTextDiff(result, CONFIG), [
    '在「騎機車自摔，」後面：「左」改成「右」',
    '在「膝擦傷約」後面：「3」改成「12」',
    '在「生命徵象穩定」後面：加上「，拒絕送醫」',
  ]);
});

test('刪掉一段：寫「刪掉」', () => {
  assert.deepEqual(
    sentencesOf('意識清楚，送醫途中血壓下降，到院後交班', '意識清楚，到院後交班'),
    ['在「意識清楚，」後面：刪掉「送醫途中血壓下降，」'],
  );
});

test('改在開頭：改用後面沒變的字定位', () => {
  assert.deepEqual(sentencesOf('左手擦傷疼痛已包紮', '疑似左手擦傷疼痛已包紮'), ['在「左手擦傷疼痛」前面：加上「疑似」']);
});

test('數字與英文字不切開：10L 改成 15L，不是 0 改成 5', () => {
  assert.deepEqual(
    sentencesOf('到院前已給予氧氣面罩10L/min 並保暖', '到院前已給予非再呼吸型面罩15L/min 並保暖'),
    ['在「到院前已給予」後面：「氧氣」改成「非再呼吸型」', '在「面罩」後面：「10L」改成「15L」'],
  );
  assert.deepEqual(sentencesOf('血壓量測 BP120/80 規則', '血壓量測 BP135/80 規則'), ['在「血壓量測」後面：「BP120」改成「BP135」']);
});

test('只差空白（PDF 切段不同）不算改動；空白夾在真的改動旁邊也不影響', () => {
  assert.equal(diffText('疑似中風左側無力送往長庚', '疑似中風 左側 無力送往長庚', CONFIG).kind, 'none');
  assert.deepEqual(sentencesOf('疑似中風 左側無力 送往 長庚', '疑似中風 左側無力   送往 長庚醫院'), ['在「送往 長庚」後面：加上「醫院」']);
});

test('整段重寫：說「整段改寫」，不被常見的字切成碎片', () => {
  const result = diffText('家屬代訴患者今日早上起床後即無法言語', '119 派遣後抵達現場發現患者倒臥在浴室地板', CONFIG);
  assert.equal(result.kind, 'rewritten');
  assert.deepEqual(describeTextDiff(result, CONFIG), ['整段改寫，請直接對照前後兩段內容']);
});

test('夾在兩處改動中間的單一個字併進改動', () => {
  // 「痛」夾在「胸→腹」與「三→兩」中間，併成一處；後面的「天」沒變
  const config = { ...CONFIG, minTextLength: 0, minUnchangedChars: 1, minUnchangedRatio: 0 };
  assert.deepEqual(sentencesOf('胸痛三天', '腹痛兩天', config), ['在「天」前面：「胸痛三」改成「腹痛兩」']);
});

test('不另外說明：短到一眼看得出、有一邊是空的、兩邊一樣', () => {
  assert.deepEqual(sentencesOf('胸痛三天', '腹痛兩天'), []);
  assert.deepEqual(sentencesOf('', '新增的補述內容很長很長'), []);
  assert.deepEqual(sentencesOf('刪掉的補述內容很長很長', ''), []);
  assert.deepEqual(sentencesOf('一樣的補述內容很長很長', '一樣的補述內容很長很長'), []);
});

test('太長不逐字比（整頁擠成一行時不算太久）', () => {
  const body = '甲乙丙丁'.repeat(800);
  const result = diffText(`開頭${body}`, `改頭${body.slice(2)}換尾`, CONFIG);
  assert.equal(result.kind, 'tooLong');
  assert.deepEqual(describeTextDiff(result, CONFIG), ['內容太長，沒有逐字比對，請直接對照前後兩段內容']);
});

test('超過上限的處數只列前面幾處，其餘寫「另有 N 處」；一處太長截斷', () => {
  const config = { ...CONFIG, maxEdits: 2, maxEditChars: 3 };
  const before = '一號甲甲甲，二號乙乙乙，三號丙丙丙，四號丁丁丁';
  const after = '一號子子子子子，二號丑丑丑，三號寅寅寅，四號卯卯卯';
  const sentences = sentencesOf(before, after, config);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0], '在「一號」後面：「甲甲甲」改成「子子子…」');
  assert.equal(sentences[2], '另有 2 處改動，請直接對照前後兩段內容');
});

test('罕用字（代理對）算一個字，不會切壞', () => {
  assert.deepEqual(sentencesOf('患者姓氏𠀋先生左手擦傷', '患者姓氏𠀋先生右手擦傷'), ['在「者姓氏𠀋先生」後面：「左」改成「右」']);
});

test('證號只改一碼：不誤判成整段改寫；改動涵蓋整格時不另外說明（改前改後已經寫了）', () => {
  assert.equal(diffText('A123456789', 'A123456780', CONFIG).kind, 'none');
  assert.deepEqual(sentencesOf('身分證 A123456789 已核對', '身分證 A123456780 已核對'), ['在「身分證」後面：「A123456789」改成「A123456780」']);
});
