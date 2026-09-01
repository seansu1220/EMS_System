/**
 * 二級以上因交通事故救護案件的資料整理測試（純函式，不需網路與瀏覽器）。
 * 執行：npm run tool:ems:test
 *
 * 測資一律用假資料（假姓名、假身分證），不放任何真實個案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toRocDate,
  parseCaseTime,
  readColumn,
  verifyExportRows,
  mergeSheetPairs,
  buildDocumentTable,
  countIncompleteIdentities,
} from './trafficCases.mjs';
import { TRAFFIC_CASE_REPORT } from './config.mjs';

/** 依匯出檔的真實欄名（含換行）造一列詳細報表一。 */
function mainRow({ key, date, place, level = '第1級', traffic = 'V', critical = 'V' }) {
  return {
    救護紀錄表單號: key,
    案發日期: date,
    發生地點: place,
    危急個案: critical,
    '受傷機轉\n(因交通事故)': traffic,
    到院後檢傷分級: level,
  };
}

/** 依匯出檔的真實欄名（含換行）造一列詳細報表二。 */
function patientRow({ key, name, id, preLevel = '第1級' }) {
  return {
    救護紀錄表單號: key,
    傷病患姓名: name,
    '身分證字號/護照號碼/居留證號碼': id,
    '到院前檢傷分級\n': preLevel,
  };
}

test('toRocDate 轉成民國格式，只留日期', () => {
  assert.equal(toRocDate('2026/08/01 05:05:03'), '115/08/01');
  assert.equal(toRocDate('2026-08-01'), '115/08/01');
  assert.equal(toRocDate('2026/8/1 05:05:03'), '115/08/01', '月日一位數要補零');
  assert.equal(toRocDate(''), '', '空值原樣回傳，交給呼叫端提醒');
  assert.equal(toRocDate('不詳'), '不詳', '認不出來就原樣回傳，不亂猜');
});

test('parseCaseTime 讀不出時間時回傳 null', () => {
  assert.equal(parseCaseTime('2026/08/01 05:05:03').getHours(), 5);
  assert.equal(parseCaseTime('2026/08/01').getFullYear(), 2026);
  assert.equal(parseCaseTime('不詳'), null);
});

test('readColumn 以「去掉空白」的欄名比對，欄位不見時中止', () => {
  const row = mainRow({ key: 'A1', date: '2026/08/01 05:05:03', place: '桃園市' });
  assert.equal(readColumn(row, '受傷機轉(因交通事故)'), 'V', '匯出檔欄名裡的換行不該影響比對');
  assert.throws(() => readColumn(row, '不存在的欄位', '詳細報表一'), /找不到欄位/);
});

test('verifyExportRows 抓出「條件選錯」的匯出檔', () => {
  const rows = [
    mainRow({ key: 'A1', date: '2026/08/01 00:00:00', place: '甲地' }),
    mainRow({ key: 'A2', date: '2026/08/02 00:00:00', place: '乙地', level: '第3級', traffic: '' }),
  ];
  const expectations = [
    { key: 'triage', column: '到院後檢傷分級', expected: '第1級', label: '到院後檢傷分級' },
    { key: 'traffic', column: '受傷機轉(因交通事故)', expected: 'V', label: '受傷機轉＝因交通事故' },
  ];
  const failed = verifyExportRows(rows, expectations);
  assert.deepEqual(failed.map((item) => item.key).sort(), ['traffic', 'triage']);
  assert.equal(failed[0].badCount, 1);

  assert.deepEqual(verifyExportRows([rows[0]], expectations), [], '全部符合時不回報任何問題');
  assert.deepEqual(verifyExportRows([], expectations), [], '沒有案件就沒得核對');
});

test('mergeSheetPairs 串起兩張工作表，並把重複的案子只算一次', () => {
  const pairs = [
    {
      levelLabel: '第1級',
      mainRows: [mainRow({ key: 'A1', date: '2026/08/02 09:00:00', place: '甲地' })],
      patientRows: [patientRow({ key: 'A1', name: '王小明', id: 'A123456789' })],
    },
    {
      levelLabel: '第2級',
      mainRows: [
        mainRow({ key: 'A1', date: '2026/08/02 09:00:00', place: '甲地', level: '第2級' }),
        mainRow({ key: 'A2', date: '2026/08/01 08:00:00', place: '乙地', level: '第2級' }),
      ],
      patientRows: [patientRow({ key: 'A2', name: '不詳', id: '', preLevel: '第2級' })],
    },
  ];
  const { cases, problems } = mergeSheetPairs(pairs, '救護紀錄表單號');
  assert.equal(cases.length, 2, '同一件出現在兩個等級只算一次');
  assert.ok(problems.some((text) => text.includes('只算一次')));
  assert.equal(cases[0].patient.傷病患姓名, '王小明');
});

test('mergeSheetPairs 對不到詳細報表二時提醒，但不中止', () => {
  const { cases, problems } = mergeSheetPairs(
    [{
      levelLabel: '第1級',
      mainRows: [mainRow({ key: 'A9', date: '2026/08/03 07:00:00', place: '丙地' })],
      patientRows: [],
    }],
    '救護紀錄表單號',
  );
  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0].patient, {});
  assert.ok(problems.some((text) => text.includes('詳細報表二')));
});

test('buildDocumentTable 依設定的欄位對應產出來文格式的列', () => {
  const { cases } = mergeSheetPairs(
    [{
      levelLabel: '第1級',
      mainRows: [
        mainRow({ key: 'B2', date: '2026/08/09 19:00:00', place: '晚的那件' }),
        mainRow({ key: 'B1', date: '2026/08/01 05:05:03', place: '早的那件' }),
      ],
      patientRows: [
        patientRow({ key: 'B1', name: '王小明', id: 'A123456789' }),
        patientRow({ key: 'B2', name: '不詳', id: '', preLevel: '第2級' }),
      ],
    }],
    TRAFFIC_CASE_REPORT.joinKeyColumn,
  );
  const table = buildDocumentTable(
    cases,
    TRAFFIC_CASE_REPORT.columnMap,
    TRAFFIC_CASE_REPORT.dateColumn,
  );

  assert.deepEqual(table.headers, [
    '編號', '發生日期', '發生地點', '當事人姓名', '身分證字號', '醫護人員檢傷分級', '五級分類', '備註',
  ]);
  assert.deepEqual(table.rows[0], [
    '1', '115/08/01', '早的那件', '王小明', 'A123456789', '第1級', '第1級', '',
  ], '依案發時間由早到晚，編號重新給');
  assert.equal(table.rows[1][0], '2');
  assert.equal(table.rows[1][6], '第2級', '五級分類取的是詳細報表二的到院前檢傷分級');
  assert.deepEqual(table.problems, []);
});

test('buildDocumentTable 讀不出日期的排最後並提醒', () => {
  const { cases } = mergeSheetPairs(
    [{
      levelLabel: '第1級',
      mainRows: [
        mainRow({ key: 'C1', date: '不詳', place: '沒有日期' }),
        mainRow({ key: 'C2', date: '2026/08/05 10:00:00', place: '有日期' }),
      ],
      patientRows: [
        patientRow({ key: 'C1', name: '甲', id: 'A1' }),
        patientRow({ key: 'C2', name: '乙', id: 'A2' }),
      ],
    }],
    TRAFFIC_CASE_REPORT.joinKeyColumn,
  );
  const table = buildDocumentTable(cases, TRAFFIC_CASE_REPORT.columnMap, TRAFFIC_CASE_REPORT.dateColumn);
  assert.equal(table.rows[0][2], '有日期');
  assert.equal(table.rows[1][2], '沒有日期');
  assert.ok(table.problems.some((text) => text.includes('讀不出日期')));
});

test('countIncompleteIdentities 數出姓名不詳與沒有身分證的件數', () => {
  const table = {
    headers: ['編號', '當事人姓名', '身分證字號'],
    rows: [
      ['1', '王小明', 'A123456789'],
      ['2', '不詳', ''],
      ['3', '', ''],
    ],
    problems: [],
  };
  assert.deepEqual(
    countIncompleteIdentities(table, TRAFFIC_CASE_REPORT.identityCheck),
    { unknownName: 2, missingId: 2 },
  );
});
