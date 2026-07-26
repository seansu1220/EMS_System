/**
 * 匯出檔讀取的整合測試：實際寫出一個 Excel 再讀回來。
 *
 * 這組測試同時守住一個容易無聲復發的問題：SheetJS 的 ESM 版本必須先 `set_fs`
 * 才能讀寫檔案，漏掉時 `readFile`/`writeFile` 會直接失敗（見 xlsxNode.mjs）。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from './xlsxNode.mjs';
import { readTable, describeWorkbook } from './workbook.mjs';
import { SQUAD_COLUMN_CANDIDATES } from './config.mjs';

/** 造一份「像政府系統匯出」的檔案：上方有說明列，欄位標題不在第一列。 */
function writeFixture(filePath) {
  const aoa = [
    ['救護紀錄表查詢結果'],
    ['查詢期間：2026-06-01 ~ 2026-06-30'],
    ['案件編號', '分隊', '送醫院所', '救護狀態'],
    ['A001', '桃園分隊', '某醫院', '已結案'],
    ['A002', '桃園分隊', '某醫院', '已結案'],
    ['A003', '大林分隊', '某醫院', '已結案'],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

test('readTable 能寫出並讀回 Excel，且正確跳過說明列', (t) => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ems-')), 'fixture.xlsx');
  t.after(() => fs.rmSync(path.dirname(filePath), { recursive: true, force: true }));

  writeFixture(filePath);
  const table = readTable(filePath, SQUAD_COLUMN_CANDIDATES);

  assert.equal(table.headerRowIndex, 2, '欄位標題在第 3 列');
  assert.deepEqual(table.headers, ['案件編號', '分隊', '送醫院所', '救護狀態']);
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0]['分隊'], '桃園分隊');
});

test('describeWorkbook 只回報結構，不回報資料列內容', (t) => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ems-')), 'fixture.xlsx');
  t.after(() => fs.rmSync(path.dirname(filePath), { recursive: true, force: true }));

  writeFixture(filePath);
  const info = describeWorkbook(filePath);

  assert.equal(info.rowCount, 6);
  assert.equal(info.columnCount, 4);
  assert.equal(info.firstRowTexts[0], '救護紀錄表查詢結果');
  const serialized = JSON.stringify(info);
  assert.ok(!serialized.includes('桃園分隊'), '不可包含任何資料列內容');
  assert.ok(!serialized.includes('A001'), '不可包含任何資料列內容');
});

test('readTable 找不到標題列時給出可讀的錯誤', (t) => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ems-')), 'bad.xlsx');
  t.after(() => fs.rmSync(path.dirname(filePath), { recursive: true, force: true }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['姓名', '年齡']]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);

  assert.throws(() => readTable(filePath, SQUAD_COLUMN_CANDIDATES), /找不到欄位標題列/);
});
