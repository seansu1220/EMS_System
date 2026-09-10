/**
 * 增減試算表逐列對帳的單元測試。
 *
 * 這支是「誰的分母可以被扣掉」的守門員，判錯就等於報表被動了手腳，
 * 因此四種判定與每一種的邊界都要釘死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_OUTCOME,
  AUDIT_COLUMNS,
  auditAdjustments,
  countApprovedBySquad,
  summarizeAudit,
  buildAuditRows,
} from './adjustAudit.mjs';

/** 組出一列增減表資料。 */
function rowOf(temsis, squad, lineNumber = 2, reason = '系統異常') {
  return { temsis, squad, caseDate: '115.08.02', isoDate: '2026-08-02', reason, lineNumber };
}

/** 未預警清單：TEMSIS → 該案實際所屬分隊。 */
const unalerted = new Map([['A1', '中路分隊'], ['A2', '山腳分隊']]);
/** 當月全部送醫案件（含有預警的 B1）。 */
const transported = new Set(['A1', 'A2', 'B1']);

test('案件在未預警清單裡 → 採計，扣該案所屬分隊', () => {
  const [result] = auditAdjustments([rowOf('A1', '中路分隊')], unalerted, transported);
  assert.equal(result.outcome, AUDIT_OUTCOME.approved);
  assert.equal(result.squad, '中路分隊');
});

test('案件本來就有預警 → 不採計', () => {
  const [result] = auditAdjustments([rowOf('B1', '中路分隊')], unalerted, transported);
  assert.equal(result.outcome, AUDIT_OUTCOME.alerted);
  assert.equal(result.squad, '', '不採計就不能指定分隊，否則會被算進扣除');
});

test('TEMSIS 在當月送醫案件裡查不到 → 不採計，說明要講出碼長', () => {
  const [result] = auditAdjustments([rowOf('20260802103522012', '中路分隊')], unalerted, transported);
  assert.equal(result.outcome, AUDIT_OUTCOME.notFound);
  assert.equal(result.squad, '');
  assert.match(result.note, /17 碼/);
});

test('TEMSIS 空白 → 不採計（查無此案），不能因為沒填就放行', () => {
  const [result] = auditAdjustments([rowOf('', '中路分隊')], unalerted, transported);
  assert.equal(result.outcome, AUDIT_OUTCOME.notFound);
  assert.match(result.note, /空的/);
});

test('同一個 TEMSIS 填第二次 → 只採計第一次', () => {
  const results = auditAdjustments(
    [rowOf('A1', '中路分隊', 2), rowOf('A1', '中路分隊', 5)],
    unalerted,
    transported,
  );
  assert.deepEqual(results.map((item) => item.outcome), [
    AUDIT_OUTCOME.approved,
    AUDIT_OUTCOME.duplicate,
  ]);
  assert.equal(countApprovedBySquad(results).get('中路分隊'), 1);
});

test('表上填的分隊與案件實際分隊不同 → 照樣採計，但扣的是實際分隊並註記', () => {
  const [result] = auditAdjustments([rowOf('A2', '中路分隊')], unalerted, transported);
  assert.equal(result.outcome, AUDIT_OUTCOME.approved);
  assert.equal(result.squad, '山腳分隊', '要扣案件實際所屬分隊，不是表上填的那一隊');
  assert.match(result.note, /山腳分隊/);
  assert.match(result.note, /中路分隊/);
});

test('countApprovedBySquad 只算採計的，不採計的一件都不能混進去', () => {
  const results = auditAdjustments(
    [rowOf('A1', '中路分隊'), rowOf('B1', '中路分隊'), rowOf('沒這個', '中路分隊')],
    unalerted,
    transported,
  );
  assert.deepEqual([...countApprovedBySquad(results)], [['中路分隊', 1]]);
});

test('summarizeAudit 四種判定都要有數字，沒發生的是 0 而不是缺項', () => {
  const counts = summarizeAudit(auditAdjustments([rowOf('A1', '中路分隊')], unalerted, transported));
  assert.equal(counts.get(AUDIT_OUTCOME.approved), 1);
  assert.equal(counts.get(AUDIT_OUTCOME.alerted), 0);
  assert.equal(counts.get(AUDIT_OUTCOME.notFound), 0);
  assert.equal(counts.get(AUDIT_OUTCOME.duplicate), 0);
});

test('對帳分頁把不採計的排前面，同組內依試算表列號', () => {
  const results = auditAdjustments(
    [rowOf('A1', '中路分隊', 2), rowOf('B1', '中路分隊', 9), rowOf('沒這個', '中路分隊', 4)],
    unalerted,
    transported,
  );
  const lineIndex = AUDIT_COLUMNS.indexOf('試算表列號');
  const outcomeIndex = AUDIT_COLUMNS.indexOf('判定');
  const rows = buildAuditRows(results);
  assert.deepEqual(rows.map((row) => row[lineIndex]), [4, 9, 2]);
  assert.equal(rows.at(-1)[outcomeIndex], AUDIT_OUTCOME.approved);
});

test('對帳分頁的 TEMSIS 是完整的，空白寫成「(空白)」', () => {
  const rows = buildAuditRows(auditAdjustments([rowOf('A1', '中路分隊'), rowOf('', '山腳分隊', 3)], unalerted, transported));
  const temsisIndex = AUDIT_COLUMNS.indexOf('TEMSIS');
  assert.deepEqual(rows.map((row) => row[temsisIndex]), ['(空白)', 'A1']);
});

test('沒有任何列時回傳空陣列，不炸掉', () => {
  assert.deepEqual(auditAdjustments([], unalerted, transported), []);
  assert.deepEqual(buildAuditRows([]), []);
  assert.equal(countApprovedBySquad([]).size, 0);
});
