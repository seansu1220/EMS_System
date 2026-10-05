/**
 * 未結案案件統整的規則測試（純函式，不需網路與瀏覽器）。
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeStatuses,
  hasClosedRecord,
  groupByDispatchNo,
  buildCaseSummary,
  countSummaries,
  buildRecordList,
  isProgressUsable,
} from './openCases.mjs';

test('summarizeStatuses 照固定順序統整，寫法比照使用者的例子', () => {
  const result = summarizeStatuses(['未填寫', '已填寫', '已結案', '已填寫']);
  assert.equal(result.text, '已結案*1+已填寫*2+未填寫*1');
  assert.deepEqual(result.counts.map((item) => item.count), [1, 2, 1]);
});

test('summarizeStatuses 不認得的狀態排最後、原樣寫出，空白也不吞掉', () => {
  assert.equal(summarizeStatuses(['審核中', '已 結案', '']).text, '已結案*1+審核中*1+（空白）*1');
  assert.equal(summarizeStatuses([]).text, '');
});

test('hasClosedRecord 只認「已結案」，不會被「未結案」騙到', () => {
  assert.equal(hasClosedRecord(['未結案', '已填寫']), false);
  assert.equal(hasClosedRecord(['未結案', ' 已結案 ']), true);
  assert.equal(hasClosedRecord([]), false);
});

test('groupByDispatchNo 同一件案子的幾台車合成一件，讀不到案號的不進來', () => {
  const groups = groupByDispatchNo([
    { temsis: 'T1', squad: '平鎮分隊', caseDate: '', dispatchNo: 'D1', error: null },
    { temsis: 'T2', squad: '龍潭分隊', caseDate: '2026/09/02 10:00', dispatchNo: 'D1', error: null },
    { temsis: 'T3', squad: '平鎮分隊', caseDate: '2026/09/03', dispatchNo: null, error: '讀不到' },
    { temsis: 'T4', squad: '平鎮分隊', caseDate: '2026/09/04', dispatchNo: 'D2', error: null },
  ]);
  assert.deepEqual([...groups.keys()], ['D1', 'D2']);
  assert.deepEqual(groups.get('D1'), {
    temsisList: ['T1', 'T2'],
    caseDate: '2026/09/02 10:00',
    squads: ['平鎮分隊', '龍潭分隊'],
  });
});

const GROUP = { temsisList: ['T1'], caseDate: '2026/09/02', squads: ['平鎮分隊'] };

test('buildCaseSummary 統整狀態，並以案件內部讀到的分隊為準', () => {
  const summary = buildCaseSummary({
    dispatchNo: 'D1',
    rows: [
      { itemNo: '1', date: '', vehicle: '平鎮91', squad: '平鎮分隊', status: '已填寫' },
      { itemNo: '2', date: '', vehicle: '龍潭92', squad: '龍潭分隊', status: '未填寫' },
    ],
    buttonCount: 2,
    caseListRows: 1,
    error: null,
  }, GROUP);
  assert.equal(summary.statusText, '已填寫*1+未填寫*1');
  assert.equal(summary.hasClosed, false);
  assert.equal(summary.recordCount, 2);
  assert.equal(summary.records.length, 2);
  assert.deepEqual(summary.squads, ['平鎮分隊', '龍潭分隊']);
  assert.deepEqual(summary.notes, []);
});

test('buildCaseSummary 列數與按鈕數對不上、案件列表多筆時要寫進備註', () => {
  const summary = buildCaseSummary({
    dispatchNo: 'D1',
    rows: [{ itemNo: '1', date: '', vehicle: '', squad: '', status: '已結案' }],
    buttonCount: 3,
    caseListRows: 2,
    error: null,
  }, GROUP);
  assert.equal(summary.hasClosed, true);
  assert.equal(summary.notes.length, 2);
  assert.match(summary.notes[0], /3 個紀錄表按鈕.*1 列/);
  assert.match(summary.notes[1], /2 列的案號都是這一號/);
  assert.deepEqual(summary.squads, ['平鎮分隊'], '案件內部讀不到分隊時退回清單上的');
});

test('buildCaseSummary 匯出檔沒有日期時退回案件內部的日期', () => {
  const summary = buildCaseSummary({
    dispatchNo: 'D1',
    rows: [
      { itemNo: '1', date: '', vehicle: '', squad: '', status: '已填寫' },
      { itemNo: '2', date: '2026/09/03 08:00', vehicle: '', squad: '', status: '已填寫' },
    ],
    buttonCount: 2,
    caseListRows: 1,
    error: null,
  }, { ...GROUP, caseDate: '' });
  assert.equal(summary.caseDate, '2026/09/03 08:00');
});

test('buildCaseSummary 讀取失敗時「有沒有已結案」是不知道（null），不是沒有', () => {
  const summary = buildCaseSummary(
    { dispatchNo: 'D1', rows: [], buttonCount: 0, caseListRows: 0, error: '進不去' },
    GROUP,
  );
  assert.equal(summary.hasClosed, null);
  assert.equal(summary.error, '進不去');
});

test('countSummaries 失敗的不算進「沒有已結案」', () => {
  const counts = countSummaries([
    { hasClosed: true }, { hasClosed: false }, { hasClosed: false }, { hasClosed: null },
  ]);
  assert.deepEqual(counts, { caseCount: 4, inspected: 3, withoutClosed: 2, withClosed: 1, failed: 1 });
});

test('buildRecordList 去掉空白與重複的 TEMSIS，沒有的欄位給空字串', () => {
  const list = buildRecordList(
    [
      { TEMSISID: ' A1 ', 出勤單位: '平鎮分隊' },
      { TEMSISID: 'A1', 出勤單位: '平鎮分隊' },
      { TEMSISID: '', 出勤單位: '龍潭分隊' },
      { TEMSISID: 'A2', 出勤單位: '龍潭分隊' },
    ],
    { temsis: 'TEMSISID', squad: '出勤單位', caseDate: null },
  );
  assert.deepEqual(list, [
    { temsis: 'A1', squad: '平鎮分隊', caseDate: '' },
    { temsis: 'A2', squad: '龍潭分隊', caseDate: '' },
  ]);
});

test('isProgressUsable 期間要相同、而且不能太舊', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const fresh = { rangeLabel: 'R', savedAt: '2026-10-05T08:00:00Z' };
  assert.equal(isProgressUsable(fresh, 'R', now), true);
  assert.equal(isProgressUsable(fresh, 'other', now), false, '不同期間不能沿用');
  assert.equal(isProgressUsable({ rangeLabel: 'R', savedAt: '2026-10-04T08:00:00Z' }, 'R', now), false, '超過 12 小時');
  assert.equal(isProgressUsable({ rangeLabel: 'R' }, 'R', now), false, '沒有時間戳');
  assert.equal(isProgressUsable(null, 'R', now), false);
});
