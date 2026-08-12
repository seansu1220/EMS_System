/**
 * OHCA 對撞診斷的純函式測試（不需要瀏覽器，也不碰檔案）。
 *
 * 釘住的是這支診斷唯一會影響結論的兩件事：
 *   - 「同一件同時掛兩種心電圖」有沒有正確找出來
 *   - 數字樣次數要**只回傳次數**，不可以把紀錄表內容帶出來
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsAlsoIn, countMarkerHits, readOhcaFields } from './ekgOhca.mjs';
import { EKG } from './config.mjs';

const TEMSIS = 'TEMSIS ID';

/** 設定檔列了幾個 OHCA 判斷欄位（比對兩件時欄位數必須固定）。 */
const EKG_FIELD_COUNT = EKG.ohca.sheetValueLabels.length;

/** 用 TEMSIS 陣列組出一份假的匯出檔資料表。 */
const tableOf = (ids) => ({
  headers: [TEMSIS, '出勤單位'],
  rows: ids.map((id) => ({ [TEMSIS]: id, 出勤單位: '三民分隊' })),
});

test('找得出同時出現在兩份查詢結果裡的案件', () => {
  const twelveLead = tableOf(['A1', 'B2', 'C3']);
  const ohca = tableOf(['B2', 'D4']);
  const shared = rowsAlsoIn(twelveLead, ohca, TEMSIS);
  assert.equal(shared.length, 1);
  assert.equal(shared[0][TEMSIS], 'B2');
});

test('兩種類型互斥時回傳空陣列，而不是全部或 null', () => {
  assert.deepEqual(rowsAlsoIn(tableOf(['A1']), tableOf(['B2']), TEMSIS), []);
  assert.deepEqual(rowsAlsoIn(tableOf([]), tableOf(['B2']), TEMSIS), []);
});

test('TEMSIS 空白的列不算重疊（空字串會把所有空白列串在一起）', () => {
  const left = tableOf(['', 'A1']);
  const right = tableOf(['', 'B2']);
  assert.deepEqual(rowsAlsoIn(left, right, TEMSIS), []);
});

test('比對前會去掉前後空白，同一件不會因為多一個空格就漏掉', () => {
  const shared = rowsAlsoIn(tableOf([' A1 ']), tableOf(['A1']), TEMSIS);
  assert.equal(shared.length, 1);
});

test('數字樣次數：重疊的不重複數，沒命中的不列出來', () => {
  const hits = countMarkerHits('OHCA 病人，OHCA 到院前心肺功能停止', ['OHCA', '心肺功能停止', 'CPR']);
  assert.deepEqual(hits, [
    { marker: 'OHCA', count: 2 },
    { marker: '心肺功能停止', count: 1 },
  ]);
});

test('數字樣只回傳次數，不可以把紀錄表內容帶出來', () => {
  // ⚠ 這是個資防線：紀錄表全文含患者資料，這支只准回報「出現幾次」。
  const text = '患者王小明，男性 62 歲，OHCA';
  const hits = countMarkerHits(text, ['OHCA']);
  const serialized = JSON.stringify(hits);
  assert.ok(!serialized.includes('王小明'), '不可帶出姓名');
  assert.ok(!serialized.includes('62'), '不可帶出年齡等前後文');
  assert.deepEqual(hits, [{ marker: 'OHCA', count: 1 }]);
});

test('沒有內容或沒有字樣時回傳空陣列，不會爆掉', () => {
  assert.deepEqual(countMarkerHits(null, ['OHCA']), []);
  assert.deepEqual(countMarkerHits('OHCA', []), []);
});

test('讀得出 OHCA 判斷欄位的值，沒填的寫「(空白)」而不是消失', () => {
  // 真正有鑑別力的是**值**，不是字樣次數（2026-08-12 實跑證實）。
  const text = '主訴：到院前心肺功能停止 旁觀者CPR：有 使用PAD：無 ROSC：08:12 手動電擊：2';
  const fields = readOhcaFields(text);
  const valueOf = (label) => fields.find((item) => item.label === label)?.value;

  assert.equal(valueOf('旁觀者CPR'), '有');
  assert.equal(valueOf('手動電擊'), '2');
  // 表單上沒有的欄位仍要出現在結果裡，否則兩件比對時欄位會對不齊。
  assert.equal(valueOf('檢傷分級'), '(空白)');
  assert.equal(fields.length, EKG_FIELD_COUNT, '欄位數要固定，比對才對得齊');
});

test('欄位值會截短，不把自由填寫欄整段帶出來', () => {
  const long = `主訴：${'胸痛'.repeat(40)}`;
  const value = readOhcaFields(long).find((item) => item.label === '主訴').value;
  assert.ok(value.length <= 20, `主訴應截短到 20 字以內，實際 ${value.length} 字`);
});

test('次數多的排前面——要一眼看出哪個字樣最有鑑別力', () => {
  const hits = countMarkerHits('OHCA OHCA OHCA CPR CPR 電擊', ['CPR', '電擊', 'OHCA']);
  assert.deepEqual(hits.map((item) => item.count), [3, 2, 1]);
  assert.equal(hits[0].marker, 'OHCA');
});

test('次數相同時排序是固定的，兩次跑出來不會不一樣', () => {
  const markers = ['OHCA', '電擊', 'CPR'];
  const first = countMarkerHits('CPR OHCA 電擊', markers).map((item) => item.marker);
  const second = countMarkerHits('電擊 CPR OHCA', [...markers].reverse()).map((item) => item.marker);
  assert.deepEqual(first, second, `排序不穩定：${first} vs ${second}`);
});
