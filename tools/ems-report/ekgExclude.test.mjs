/**
 * 排除 OHCA 案件（處置勾 CPR）的測試——純函式，不需要瀏覽器也不碰檔案。
 *
 * 這段會**直接改動報表數字**，所以邊界要釘死：
 *   - 兩份匯出檔都有的同一件，只能算一次（不然報告上的件數會虛報）
 *   - TEMSIS 空白的不可以被當成要排除的而消失
 *   - 沒被排除的一列都不能少
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitExcluded, temsisSetOf, excludeOhcaCases } from './ekgExclude.mjs';

const TEMSIS = 'TEMSIS ID';
const SQUAD = '出勤單位';
const CASE_DATE = '案發日期';

/** 組一列匯出資料。 */
const row = (temsis, squad = '三民分隊', caseDate = '2026/07/12 15:38:39') => ({
  [TEMSIS]: temsis,
  [SQUAD]: squad,
  [CASE_DATE]: caseDate,
});

/** 組一個要餵給 excludeOhcaCases 的來源。 */
const sourceOf = (rows, label) => ({
  rows,
  temsisColumn: TEMSIS,
  squadColumn: SQUAD,
  caseDateColumn: CASE_DATE,
  label,
});

test('temsisSetOf 取出所有 TEMSIS，去空白、略過空值', () => {
  const found = temsisSetOf([row(' A1 '), row(''), row('B2'), row(null)], TEMSIS);
  assert.deepEqual([...found].sort(), ['A1', 'B2']);
});

test('splitExcluded 把要排除的拆出來，其餘一列都不少', () => {
  const rows = [row('A1'), row('B2'), row('C3')];
  const { kept, removed } = splitExcluded(rows, TEMSIS, new Set(['B2']));
  assert.deepEqual(kept.map((item) => item[TEMSIS]), ['A1', 'C3']);
  assert.deepEqual(removed.map((item) => item[TEMSIS]), ['B2']);
});

test('TEMSIS 空白的一律留著，不可以被當成 OHCA 而消失', () => {
  // ⚠ 空字串是資料本身的問題，不是「這件是 OHCA」。排掉的話會無聲少算一件。
  const { kept, removed } = splitExcluded([row(''), row('A1')], TEMSIS, new Set(['A1']));
  assert.equal(kept.length, 1);
  assert.equal(kept[0][TEMSIS], '');
  assert.equal(removed.length, 1);
});

test('沒有要排除的東西時，資料原封不動', () => {
  const rows = [row('A1'), row('B2')];
  const { kept, removed } = splitExcluded(rows, TEMSIS, new Set());
  assert.equal(kept.length, 2);
  assert.deepEqual(removed, []);
});

test('兩份匯出檔都有的同一件只算一次，並記下兩邊都有', () => {
  // ⚠ 不去重的話執行報告上的件數會比實際多——那是會被拿去對外解釋的數字。
  const result = excludeOhcaCases(
    [
      sourceOf([row('A1'), row('B2')], '有勾EKG檢查'),
      sourceOf([row('A1'), row('C3')], '有12導程'),
    ],
    new Set(['A1']),
  );

  assert.equal(result.cases.length, 1, 'A1 只能出現一次');
  assert.equal(result.cases[0].temsis, 'A1');
  assert.match(result.cases[0].from, /有勾EKG檢查.*有12導程/);
  assert.deepEqual(result.kept[0].map((item) => item[TEMSIS]), ['B2']);
  assert.deepEqual(result.kept[1].map((item) => item[TEMSIS]), ['C3']);
});

test('只出現在其中一份時，from 只記那一份', () => {
  const result = excludeOhcaCases(
    [
      sourceOf([row('A1')], '有勾EKG檢查'),
      sourceOf([row('B2')], '有12導程'),
    ],
    new Set(['B2']),
  );
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].from, '有12導程');
  assert.deepEqual(result.kept[0].map((item) => item[TEMSIS]), ['A1']);
});

test('各分隊件數算得出來，供執行報告直接列出', () => {
  const result = excludeOhcaCases(
    [sourceOf([
      row('A1', '三民分隊'),
      row('B2', '平鎮分隊'),
      row('C3', '平鎮分隊'),
      row('D4', '龜山分隊'),
    ], '有12導程')],
    new Set(['A1', 'B2', 'C3']),
  );
  assert.equal(result.cases.length, 3);
  assert.equal(result.countsBySquad.get('平鎮分隊'), 2);
  assert.equal(result.countsBySquad.get('三民分隊'), 1);
  assert.equal(result.countsBySquad.has('龜山分隊'), false, 'D4 沒被排除，不該出現');
});

test('讀不到分隊或日期時給得出可讀的字，不會是 undefined', () => {
  const result = excludeOhcaCases(
    [{ rows: [{ [TEMSIS]: 'A1' }], temsisColumn: TEMSIS, squadColumn: SQUAD, caseDateColumn: null, label: '有12導程' }],
    new Set(['A1']),
  );
  assert.equal(result.cases[0].squad, '(讀不到分隊)');
  assert.equal(result.cases[0].caseDate, '(讀不到)');
});

test('一件都沒排除時，kept 與原資料等長，cases 為空', () => {
  const rows = [row('A1'), row('B2')];
  const result = excludeOhcaCases([sourceOf(rows, '有12導程')], new Set(['沒有這一件']));
  assert.equal(result.kept[0].length, 2);
  assert.deepEqual(result.cases, []);
  assert.equal(result.countsBySquad.size, 0);
});
