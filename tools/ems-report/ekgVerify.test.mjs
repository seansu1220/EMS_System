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
import { resolveColumnByNames } from './aggregate.mjs';

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

test('上傳時間優先取「上傳時間」欄，不是該列第一個數字', () => {
  const panel = {
    headers: ['項次', '檔案名稱', '建立時間', '上傳時間'],
    rows: [['1', '12導程心電圖.pdf', '2026/07/02 11:00:00', '2026/07/02 12:30:00']],
  };
  const picked = pickEarliestUploadTime(panel, CONTEXT);
  assert.equal(picked.time.epochMs, Date.UTC(2026, 6, 2, 12, 30, 0));
  assert.match(picked.from, /上傳時間/);
});

test('傳過好幾次時取最早的一次（只要曾在到院前傳出去就算數）', () => {
  const panel = {
    headers: ['項次', '檔案名稱', '上傳時間'],
    rows: [
      ['2', '12導程心電圖-重傳.pdf', '2026/07/02 13:10:00'],
      ['1', '12導程心電圖.pdf', '2026/07/02 12:20:00'],
    ],
  };
  const picked = pickEarliestUploadTime(panel, CONTEXT);
  assert.equal(picked.time.epochMs, Date.UTC(2026, 6, 2, 12, 20, 0));
});

test('沒有可辨識的時間欄時，退回逐格找第一個看得懂的時間', () => {
  const panel = {
    headers: ['項次', '檔案', '備註'],
    rows: [['1', '12導程心電圖.pdf', '2026/07/02 12:20:00 由平鎮92上傳']],
  };
  const picked = pickEarliestUploadTime(panel, CONTEXT);
  assert.equal(picked.time.epochMs, Date.UTC(2026, 6, 2, 12, 20, 0));
  assert.match(picked.from, /第一個看得懂/);
});

test('整張表都讀不出時間時回傳 null，不猜', () => {
  const panel = { headers: ['項次', '檔案'], rows: [['1', '12導程心電圖.pdf']] };
  assert.equal(pickEarliestUploadTime(panel, CONTEXT), null);
  assert.equal(pickEarliestUploadTime({ headers: [], rows: [] }, CONTEXT), null);
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

test('resolveColumnByNames 完全相符優先，其次取最短的包含者', () => {
  const headers = ['TEMSIS ID 修改人', 'TEMSISID', '出勤單位'];
  assert.equal(resolveColumnByNames(headers, ['TEMSISID']).column, 'TEMSISID');
  // 只有「包含」時取最短的，避免選到複合欄（第 1 章曾因此整份報表算錯）。
  assert.equal(resolveColumnByNames(['TEMSIS ID 修改人', 'TEMSIS ID'], ['TEMSISID']).column, 'TEMSIS ID');
  assert.equal(resolveColumnByNames(headers, ['完全不存在的欄']), null);
});
