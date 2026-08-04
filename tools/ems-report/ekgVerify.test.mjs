/**
 * 心電圖逐案查核的單元測試（只測純函式，不開瀏覽器、不連網）。
 *
 * 這些函式決定「誰進分子、誰進人工確認清單」，錯了不會有任何錯誤訊息，
 * 只會讓報表默默算錯，因此把規則一條一條釘住。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaseList,
  countVerifiedBySquad,
  pickEarliestUploadTime,
  resolveEkgColumns,
  VERDICT,
} from './ekgVerify.mjs';
import { resolveColumnByNames, countUnionBySquad } from './aggregate.mjs';
import { EKG, QUERY_CRITERIA } from './config.mjs';

const CONTEXT = { defaultYear: 2026, defaultDate: '2026-07-02' };

test('buildCaseList 取出 TEMSIS、分隊與到院時間', () => {
  const rows = [
    { TEMSISID: 'T1150701001', 出勤單位: '桃園分隊', 到院時間: '2026/07/02 12:44:08' },
    { TEMSISID: 'T1150701002', 出勤單位: '中壢分隊', 到院時間: '' },
  ];
  const cases = buildCaseList(rows, { temsis: 'TEMSISID', squad: '出勤單位', arrival: '到院時間' });
  assert.deepEqual(cases, [
    { temsis: 'T1150701001', squad: '桃園分隊', arrivalText: '2026/07/02 12:44:08' },
    { temsis: 'T1150701002', squad: '中壢分隊', arrivalText: '' },
  ]);
});

test('buildCaseList 跳過沒有 TEMSIS 或沒有分隊的列（匯出檔常見的表尾合計、空行）', () => {
  const rows = [
    { TEMSISID: '', 出勤單位: '桃園分隊' },
    { TEMSISID: 'T1150701003', 出勤單位: '' },
    { TEMSISID: 'T1150701004', 出勤單位: '大溪分隊' },
  ];
  const cases = buildCaseList(rows, { temsis: 'TEMSISID', squad: '出勤單位', arrival: null });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].temsis, 'T1150701004');
  assert.equal(cases[0].arrivalText, '', '匯出檔沒有到院時間欄時留空字串，交由逐案讀取');
});

test('沒有 TEMSIS 欄就中止，並把實際欄名寫進錯誤訊息', () => {
  const table = { headers: ['出勤單位', '姓名', '到院時間'], rows: [] };
  assert.throws(
    () => resolveEkgColumns(table, resolveColumnByNames),
    (error) => {
      assert.match(error.message, /找不到 TEMSIS 欄/);
      assert.match(error.message, /出勤單位/, '要列出實際欄名，才知道該把哪個欄名加進設定');
      return true;
    },
  );
});

test('到院時間欄要「內容真的是時間」才採用，只是欄名像不算', () => {
  const rows = [
    { TEMSISID: 'A1', 到院時間: '2026/07/02 12:44:08' },
    { TEMSISID: 'A2', 到院時間: '2026/07/03 08:10:00' },
    { TEMSISID: 'A3', 到院時間: '' },
  ];
  const resolved = resolveEkgColumns({ headers: ['TEMSISID', '到院時間'], rows }, resolveColumnByNames);
  assert.equal(resolved.temsis, 'TEMSISID');
  assert.equal(resolved.arrival, '到院時間');
});

test('欄名像到院時間、內容卻不是時間時不採用，改為逐案讀取', () => {
  // 例如命中「到院時間填寫人」這種欄——用了就會整批判定錯誤。
  const rows = [
    { TEMSISID: 'A1', 到院時間: '王小明' },
    { TEMSISID: 'A2', 到院時間: '李小華' },
    { TEMSISID: 'A3', 到院時間: '陳大同' },
  ];
  const resolved = resolveEkgColumns({ headers: ['TEMSISID', '到院時間'], rows }, resolveColumnByNames);
  assert.equal(resolved.arrival, null);
  assert.ok(
    resolved.notes.some((note) => note.includes('不採用')),
    '要說明為什麼不用這一欄，否則使用者只會覺得跑得莫名其妙慢',
  );
});

test('上傳時間優先取「上傳時間」欄，不是排在前面的建立時間', () => {
  // 設定檔把「上傳時間」排在「建立時間」前面就是要讓它優先；
  // 若照欄位順序找，建立時間會先命中而取到錯的時間（兩者可能差幾十分鐘）。
  const matched = [{
    marker: '12導程心電圖',
    values: { 建立時間: '2026/07/02 11:00:00', 上傳時間: '2026/07/02 12:30:00' },
  }];
  const picked = pickEarliestUploadTime(matched, CONTEXT);
  assert.equal(picked.time.epochMs, Date.UTC(2026, 6, 2, 12, 30, 0));
  assert.match(picked.from, /上傳時間/);
});

test('傳過好幾次時取最早的一次（只要曾在到院前傳出去就算數）', () => {
  const matched = [
    { marker: '12導程心電圖', values: { 上傳時間: '2026/07/02 13:10:00' } },
    { marker: '12導程心電圖', values: { 上傳時間: '2026/07/02 12:20:00' } },
  ];
  assert.equal(pickEarliestUploadTime(matched, CONTEXT).time.epochMs, Date.UTC(2026, 6, 2, 12, 20, 0));
});

test('欄名對不上時，退回該列取回來的值裡第一個看得懂的時間', () => {
  const matched = [{ marker: '12導程心電圖', values: { 備註: '2026/07/02 12:20:00 由平鎮92上傳' } }];
  const picked = pickEarliestUploadTime(matched, CONTEXT);
  assert.equal(picked.time.epochMs, Date.UTC(2026, 6, 2, 12, 20, 0));
  assert.match(picked.from, /第一個看得懂/);
});

test('整批都讀不出時間時回傳 null，不猜', () => {
  assert.equal(pickEarliestUploadTime([{ marker: 'x', values: { 檔案類型: '12導程心電圖' } }], CONTEXT), null);
  assert.equal(pickEarliestUploadTime([], CONTEXT), null);
  assert.equal(pickEarliestUploadTime(null, CONTEXT), null);
});

test('傳輸紀錄改用「量測時間」當時間欄，共用同一支挑選函式', () => {
  const matched = [
    { marker: 'V', values: { 量測時間: '2026/07/01 09:40:00' } },
    { marker: 'V', values: { 量測時間: '2026/07/01 09:33:16' } },
  ];
  const picked = pickEarliestUploadTime(matched, CONTEXT, ['量測時間']);
  assert.equal(picked.time.epochMs, Date.UTC(2026, 6, 1, 9, 33, 16));
});

test('只有判定為「到院前」的才計入分子', () => {
  const outcomes = [
    { squad: '桃園分隊', verdict: VERDICT.before },
    { squad: '桃園分隊', verdict: VERDICT.before },
    { squad: '桃園分隊', verdict: VERDICT.after },
    { squad: '桃園分隊', verdict: VERDICT.unknown },
    { squad: '中壢分隊', verdict: VERDICT.before },
    { squad: '', verdict: VERDICT.before },
  ];
  const counts = countVerifiedBySquad(outcomes);
  assert.equal(counts.get('桃園分隊'), 2, '到院後與判定不出來的都不算');
  assert.equal(counts.get('中壢分隊'), 1);
  assert.equal(counts.has(''), false, '沒有分隊的不列入');
});

test('全部都判定不出來時分子為 0，而不是拿原始件數頂替', () => {
  const outcomes = [
    { squad: '桃園分隊', verdict: VERDICT.unknown },
    { squad: '中壢分隊', verdict: VERDICT.unknown },
  ];
  assert.equal(countVerifiedBySquad(outcomes).size, 0);
});

test('分母取聯集：兩份都有的案件只算一次', () => {
  // 使用者 2026-08-04 決定：分母＝有勾 EKG檢查「或」有 12 導程。
  // 實測兩者互有出入（243／285／交集 202），取聯集才不會漏掉任一邊獨有的案件。
  const ekgChecked = {
    rows: [
      { T: 'A1', S: '桃園分隊' },
      { T: 'A2', S: '桃園分隊' },
      { T: 'A3', S: '中壢分隊' },
    ],
    temsisColumn: 'T',
    squadColumn: 'S',
  };
  const twelveLead = {
    rows: [
      { T: 'A2', S: '桃園分隊' }, // 兩份都有，只能算一次
      { T: 'B1', S: '桃園分隊' }, // 只有 12 導程有
      { T: 'B2', S: '大溪分隊' },
    ],
    temsisColumn: 'T',
    squadColumn: 'S',
  };
  const { counts, total, conflicts } = countUnionBySquad([ekgChecked, twelveLead]);
  assert.equal(total, 5, 'A1 A2 A3 B1 B2 共 5 件，A2 重複只算一次');
  assert.equal(counts.get('桃園分隊'), 3);
  assert.equal(counts.get('中壢分隊'), 1);
  assert.equal(counts.get('大溪分隊'), 1);
  assert.deepEqual(conflicts, []);
});

test('同一件案子在兩份檔案裡分隊不一致時要提出來，不默默挑一個', () => {
  const left = { rows: [{ T: 'A1', S: '桃園分隊' }], temsisColumn: 'T', squadColumn: 'S' };
  const right = { rows: [{ T: 'A1', S: '中壢分隊' }], temsisColumn: 'T', squadColumn: 'S' };
  const { counts, total, conflicts } = countUnionBySquad([left, right]);
  assert.equal(total, 1);
  assert.equal(counts.get('桃園分隊'), 1, '以先出現的為準');
  assert.deepEqual(conflicts, ['A1']);
});

test('聯集會跳過沒有 TEMSIS 或沒有分隊的列', () => {
  const source = {
    rows: [{ T: '', S: '桃園分隊' }, { T: 'A1', S: '' }, { T: 'A2', S: '桃園分隊' }],
    temsisColumn: 'T',
    squadColumn: 'S',
  };
  assert.equal(countUnionBySquad([source]).total, 1);
});

test('分子必定是聯集分母的子集合（比率不可能超過 100%）', () => {
  // 分子取自 12 導程那份，而 12 導程整份都在聯集裡，所以逐隊都不可能超過。
  const twelveLead = {
    rows: [
      { T: 'B1', S: '桃園分隊' },
      { T: 'B2', S: '桃園分隊' },
      { T: 'B3', S: '中壢分隊' },
    ],
    temsisColumn: 'T',
    squadColumn: 'S',
  };
  const ekgChecked = { rows: [{ T: 'A1', S: '中壢分隊' }], temsisColumn: 'T', squadColumn: 'S' };
  const { counts } = countUnionBySquad([ekgChecked, twelveLead]);

  // 最極端的情況：12 導程那份**全部**查核通過。
  const numerator = countVerifiedBySquad(
    twelveLead.rows.map((row) => ({ squad: row.S, verdict: VERDICT.before })),
  );
  for (const [squad, count] of numerator) {
    assert.ok(count <= counts.get(squad), `${squad} 的分子 ${count} 不該超過分母 ${counts.get(squad)}`);
  }
});

test('兩次查詢的基準條件是「已結案＋送醫」，且與第 1 章同一組代碼', () => {
  // 使用者 2026-08-05 決定加上這兩個條件：未運送的案件沒有「送達醫院時間」，
  // 留在母體裡只會變成「無法判定」，白白多一件要人工判。
  // 這裡釘住的是「別哪天被改回不限卻沒人發現」——那會讓母體悄悄變大。
  assert.equal(EKG.baseCriteria.rescueStatus, QUERY_CRITERIA.rescueStatusValue);
  assert.equal(EKG.baseCriteria.transport, QUERY_CRITERIA.transportValue);
  assert.ok(EKG.baseCriteria.rescueStatus, '救護狀態不可以是空字串（空＝不限）');
  assert.ok(EKG.baseCriteria.transport, '送醫情形不可以是空字串（空＝不限）');
});

test('上傳清單只認檔案類型欄，設定不可退回比對整列文字', () => {
  // 2026-08-05 使用者指正：備註寫著「12導程操作說明書」的案件會被誤算。
  assert.deepEqual(EKG.verify.fileTypeColumns, ['檔案類型']);
  assert.ok(EKG.verify.maxAttemptsPerCase >= 2, '暫時性失敗要能重試，否則會變成人工案件');
});

test('resolveColumnByNames 完全相符優先，其次取最短的包含者', () => {
  const headers = ['TEMSIS ID 修改人', 'TEMSISID', '出勤單位'];
  assert.equal(resolveColumnByNames(headers, ['TEMSISID']).column, 'TEMSISID');
  // 只有「包含」時取最短的，避免選到複合欄（第 1 章曾因此整份報表算錯）。
  assert.equal(resolveColumnByNames(['TEMSIS ID 修改人', 'TEMSIS ID'], ['TEMSISID']).column, 'TEMSIS ID');
  assert.equal(resolveColumnByNames(headers, ['完全不存在的欄']), null);
});
