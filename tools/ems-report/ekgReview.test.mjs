/**
 * 人工判定清單的測試。
 *
 * 釘住的是整條來回**不會把使用者填的東西弄丟**——那是這個功能唯一的失敗模式，
 * 而且弄丟了完全看不出來（數字只是默默變回程式的判定）。
 *
 * 寫檔那幾項會實際產生檔案再讀回來（同一份程式寫、同一份程式讀，
 * 光測純函式證明不了「存檔之後真的讀得回來」），因此用暫存資料夾，
 * 跑完就刪，不會動到使用者 out/ 底下的東西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  DECISION,
  REVIEW_COLUMN,
  REVIEW_COLUMNS,
  applyDecisions,
  buildReviewRows,
  mergeReviewRows,
  parseDecision,
  readDecisions,
  reviewFilePath,
  writeReviewList,
} from './ekgReview.mjs';
import { countsAsNumerator, VERDICT } from './ekgVerify.mjs';
import { PATHS } from './config.mjs';

const MONTH = { start: '2026-07-01', end: '2026-07-31', label: '2026-07' };
const at = (row, columnName) => row[REVIEW_COLUMNS.indexOf(columnName)];

const outcome = (temsis, extra = {}) => ({
  temsis, squad: '平鎮分隊', verdict: VERDICT.unknown, reason: '以 TEMSIS 查不到案件',
  arrival: null, upload: null, source: '', caseDate: '2026/07/06',
  remark: null, mediaReviews: [], ...extra,
});

const mediaReview = (extra = {}) => ({
  fileName: 'IMG_0001.jpg',
  url: 'https://emsdt.tyfd.gov.tw/AppFileExplorer/download/2026/07/9/IMG_0001.jpg',
  uploadTime: '2026/07/06 12:40:45',
  timing: '到院前',
  kind: '程式讀不出內容',
  why: '照片辨識試了 3 輪都讀不出任何字',
  remark: '',
  ...extra,
});

test('判定寫法放寬：算／是／Y／V 都認得，不算／否／N／X 也是', () => {
  // 這一欄是人手填的。只認兩個特定字的話，「填了但寫法不同」會默默失效，
  // 而那是完全看不出來的錯。
  for (const text of ['算', '計入', '是', 'y', ' V ', '✓', '1']) {
    assert.equal(parseDecision(text), DECISION.count, `「${text}」應該是算`);
  }
  for (const text of ['不算', '否', 'N', 'x', '0']) {
    assert.equal(parseDecision(text), DECISION.skip, `「${text}」應該是不算`);
  }
});

test('沒填回傳 null，填了但看不懂回傳「看不懂」——兩者不可以混為一談', () => {
  // 沒填＝還沒看；看不懂＝看了也填了，只是寫法不對，要提醒他改。
  assert.equal(parseDecision(''), null);
  assert.equal(parseDecision('   '), null);
  assert.equal(parseDecision('大概算吧'), '看不懂');
});

test('人工判定蓋掉程式的判定，兩個方向都要成立', () => {
  const decisions = new Map([
    ['T-1', { decision: DECISION.count, note: '照片就是 12 導程' }],
    ['T-2', { decision: DECISION.skip, note: '那是現場照片' }],
  ]);
  const result = applyDecisions(
    [outcome('T-1'), outcome('T-2', { verdict: VERDICT.before }), outcome('T-3')],
    decisions,
  );

  assert.equal(result.counted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(countsAsNumerator(result.outcomes[0]), true, '判不出來但填「算」→ 要計入');
  assert.equal(countsAsNumerator(result.outcomes[1]), false, '程式判到院前但填「不算」→ 不計入');
  assert.equal(countsAsNumerator(result.outcomes[2]), false, '沒填的照程式的判定走');
});

test('套判定不可以改寫 verdict——判定欄要照實寫程式判成什麼', () => {
  // 直接把 verdict 改成「到院前」比較省事，但那樣逐案判定表就看不出
  // 「這件是人工決定的」，日後沒人說得清數字怎麼來的。
  const result = applyDecisions([outcome('T-1')], new Map([['T-1', { decision: DECISION.count, note: '' }]]));
  assert.equal(result.outcomes[0].verdict, VERDICT.unknown);
  assert.equal(result.outcomes[0].manual.decision, DECISION.count);
});

test('填了判定但這次查核結果裡沒有那件案子，要回報出來', () => {
  const result = applyDecisions([outcome('T-1')], new Map([['T-9', { decision: DECISION.count, note: '' }]]));
  assert.deepEqual(result.missing, ['T-9']);
});

test('要人看的兩種案件都會進清單，同一件只出一列', () => {
  const rows = buildReviewRows([
    outcome('T-1'),
    outcome('T-2', { verdict: VERDICT.after, mediaReviews: [mediaReview(), mediaReview({ fileName: 'IMG_2.jpg' })] }),
    outcome('T-3', { verdict: VERDICT.before }),
  ], VERDICT.unknown);

  assert.equal(rows.length, 2, '判定不出來的一件 ＋ 有影音判不出來的一件；判到院前的不必看');
  assert.match(String(at(rows[0], '為什麼要你看')), /判定不出來/);
  assert.match(String(at(rows[1], '為什麼要你看')), /2 個檔案/);
  // 一件出好幾列的話，使用者可以在同一件上填出互相矛盾的答案。
  assert.equal(at(rows[1], '相關檔案').split('\n').length, 2, '同一件的多個檔案放在同一格');
  assert.match(String(at(rows[1], '檔案連結（點開看）')), /^https:\/\//);
});

test('合併：這次還要看的案件，沿用上次填的判定與備註', () => {
  const fresh = buildReviewRows([outcome('T-1')], VERDICT.unknown);
  const previous = new Map([['T-1', REVIEW_COLUMNS.map((name) =>
    (name === 'TEMSIS' ? 'T-1' : name === REVIEW_COLUMN ? DECISION.count : name === '你的備註' ? '看過了' : ''))]]);

  const merged = mergeReviewRows(fresh, previous, new Map([['T-1', { decision: DECISION.count, note: '看過了' }]]));
  assert.equal(merged.length, 1);
  assert.equal(at(merged[0], REVIEW_COLUMN), DECISION.count);
  assert.equal(at(merged[0], '你的備註'), '看過了');
  assert.match(String(at(merged[0], '為什麼要你看')), /判定不出來/, '顯示欄要用這次的最新結果');
});

test('合併：程式這次判得出來了，填過判定的那一列仍然要留著', () => {
  // ⚠ 這是整個功能最容易出的錯。刪掉的話下一次跑就掉回程式的判定，
  //   數字會自己變來變去，而使用者完全不知道發生什麼事。
  const previous = new Map([['T-9', REVIEW_COLUMNS.map((name) =>
    (name === 'TEMSIS' ? 'T-9' : name === REVIEW_COLUMN ? DECISION.skip : ''))]]);
  const merged = mergeReviewRows([], previous, new Map([['T-9', { decision: DECISION.skip, note: '' }]]));

  assert.equal(merged.length, 1);
  assert.equal(at(merged[0], 'TEMSIS'), 'T-9');
  assert.match(String(at(merged[0], '為什麼要你看')), /保留你先前填的判定/);
});

test('合併：上次沒填判定、這次也不用看的案件，就不必留著了', () => {
  const previous = new Map([['T-9', REVIEW_COLUMNS.map((name) => (name === 'TEMSIS' ? 'T-9' : ''))]]);
  assert.deepEqual(mergeReviewRows([], previous, new Map()), []);
});

test('沒填的排前面：使用者開檔案要做的事就是填那些', () => {
  const rows = [
    ['甲隊', '', 'T-1', '', '', '', '', '', '', '', DECISION.count, ''],
    ['乙隊', '', 'T-2', '', '', '', '', '', '', '', '', ''],
  ];
  const merged = mergeReviewRows(rows, new Map(), new Map());
  assert.equal(at(merged[0], 'TEMSIS'), 'T-2');
});

test('整條來回：寫出去的檔案，填了判定之後讀得回來', async (context) => {
  // 光測純函式證明不了「存檔之後真的讀得回來」——欄名對不上、標題列位置變了
  // 都只會在真的讀檔時才爆出來，而那時已經是使用者在用了。
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-review-'));
  const original = PATHS.internalDir;
  PATHS.internalDir = temporary;
  context.after(async () => {
    PATHS.internalDir = original;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const rows = buildReviewRows([
    outcome('2026070610100310380201'),
    outcome('2026070610100310380202', { verdict: VERDICT.after, mediaReviews: [mediaReview()] }),
  ], VERDICT.unknown);
  const written = await writeReviewList(rows, MONTH);
  assert.ok(written.filePath, '應該要寫出檔案');
  assert.equal(written.pending, 2, '兩件都還沒填');

  // 模擬使用者開 Excel 填了判定再存檔。
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(reviewFilePath(MONTH));
  const sheet = workbook.worksheets[0];
  const decisionColumn = REVIEW_COLUMNS.indexOf(REVIEW_COLUMN) + 1;
  const noteColumn = REVIEW_COLUMNS.indexOf('你的備註') + 1;
  sheet.getCell(3, decisionColumn).value = DECISION.count;
  sheet.getCell(3, noteColumn).value = '點開看過，是 12 導程';
  sheet.getCell(4, decisionColumn).value = '大概吧'; // 看不懂的寫法
  await workbook.xlsx.writeFile(reviewFilePath(MONTH));

  const readBack = await readDecisions(MONTH);
  assert.equal(readBack.decisions.size, 1);
  assert.equal(readBack.unreadable.length, 1, '看不懂的要回報，不可以默默當成沒填');
  const [[temsis, decision]] = [...readBack.decisions];
  assert.equal(decision.decision, DECISION.count);
  assert.equal(decision.note, '點開看過，是 12 導程');
  assert.equal(readBack.rows.size, 2, '整列都要記下來，重寫檔案時才留得住');

  // 套進查核結果之後，那一件就算進分子了。
  const applied = applyDecisions([outcome(temsis)], readBack.decisions);
  assert.equal(countsAsNumerator(applied.outcomes[0]), true);
});

test('清單一列都沒有時不刪舊檔——那裡面裝的是使用者的判定，不是這次的結果', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-review-'));
  const original = PATHS.internalDir;
  PATHS.internalDir = temporary;
  context.after(async () => {
    PATHS.internalDir = original;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  await writeReviewList(buildReviewRows([outcome('T-1')], VERDICT.unknown), MONTH);
  const result = await writeReviewList([], MONTH);
  assert.equal(result.filePath, null);
  await assert.doesNotReject(fs.access(reviewFilePath(MONTH)), '舊檔要原樣留著');
});

test('檔案不存在時安靜地回空的，不可以讓整個月報表跑不出來', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-review-'));
  const original = PATHS.internalDir;
  PATHS.internalDir = temporary;
  context.after(async () => {
    PATHS.internalDir = original;
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const result = await readDecisions(MONTH);
  assert.equal(result.decisions.size, 0);
  assert.deepEqual(result.unreadable, []);
});
