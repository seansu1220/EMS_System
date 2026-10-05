/**
 * 來文格式版面的測試：確認程式排出來的表**跟上級發文的空白格式長得一樣**。
 *
 * 為什麼需要這一組：版面已經不再讀範本檔（值記在 config 裡），
 * 改壞了不會有任何錯誤訊息，只會安靜地交出一份版面不對的公文。
 * 這裡把「跟範本比對過的那些值」釘住——同時也拿真正的 `來文格式.xlsx`
 * 逐項對照（那個檔還在捷徑資料夾，就是當初照抄的依據；不在就跳過那一個測試）。
 *
 * ⚠ 測資全部是編的假資料，不含任何真實個案。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createReportWorkbook } from './trafficReport.mjs';
import { PATHS, TRAFFIC_CASE_REPORT } from './config.mjs';

/** 兩列假資料，欄數與 columnMap 相同。 */
const TABLE = {
  headers: TRAFFIC_CASE_REPORT.columnMap.map((column) => column.title),
  rows: [
    ['1', '115/08/01', '桃園市某某路一段1號', '王小明', 'A123456789', '第1級', '第1級', ''],
    ['2', '115/08/02', '桃園市某某路二段2號', '不詳', '', '第2級', '未評', ''],
  ],
  problems: [],
};

/** 當初照抄版面的那個範本；完整安裝才有（可攜版沒有，測試自動跳過）。 */
const TEMPLATE_FILE = path.join(
  PATHS.toolDir, '..', '..', '捷徑', '二級以上因交通事故救護案件', '來文格式.xlsx',
);

const sheetOf = () => createReportWorkbook(TABLE).worksheets[0];

test('標題列跨整個表格寬度合併，文字與來文相同', () => {
  const sheet = sheetOf();
  assert.equal(sheet.getCell('A1').value, TRAFFIC_CASE_REPORT.layout.title);
  assert.deepEqual(sheet.model.merges, ['A1:H1']);
  assert.equal(sheet.getRow(1).height, TRAFFIC_CASE_REPORT.layout.titleRowHeight);
});

test('欄位標題列照來文的寫法，分兩行的那一格會自動換行', () => {
  const sheet = sheetOf();
  const row = sheet.getRow(2);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((column) => row.getCell(column).value),
    ['編號', '發生日期', '發生地點', '當事人姓名', '身分證字號', '醫護人員\n檢傷分級', '五級分類', '備註'],
  );
  assert.equal(row.getCell(6).alignment.wrapText, true, '分兩行的標題要開換行');
  assert.equal(row.getCell(1).alignment.wrapText, false);
  assert.equal(row.getCell(1).border.top.style, TRAFFIC_CASE_REPORT.layout.borderStyle);
});

test('資料從第 3 列開始，每一格都有框線；地點靠左、其餘置中', () => {
  const sheet = sheetOf();
  assert.equal(sheet.getCell('A3').value, '1');
  assert.equal(sheet.getCell('B3').value, '115/08/01');
  assert.equal(sheet.getCell('F4').value, '第2級');
  assert.equal(sheet.getCell('E4').value, '', '沒有身分證字號的留白');

  const dataCell = sheet.getCell('A3');
  assert.equal(dataCell.border.bottom.style, TRAFFIC_CASE_REPORT.layout.borderStyle);
  assert.equal(dataCell.font.size, TRAFFIC_CASE_REPORT.layout.dataFontSize);
  assert.equal(dataCell.alignment.horizontal, 'center');
  assert.equal(sheet.getCell('C3').alignment.horizontal, 'left', '發生地點靠左');
});

test('長地址那一列自動加高，短的維持範本列高（避免切字）', () => {
  const longAddress = '桃園市桃園區某某醫院往某某公園透過路燈0000000轉換GIS座標(25.0000,121.0000)';
  const sheet = createReportWorkbook({
    ...TABLE,
    rows: [
      ['1', '115/08/01', '中壢區某路1號', '王小明', 'A123456789', '第1級', '第1級', ''],
      ['2', '115/08/03', longAddress, '王小明', 'A123456789', '第2級', '第2級', ''],
    ],
  }).worksheets[0];
  const minHeight = TRAFFIC_CASE_REPORT.layout.dataRowHeight;
  assert.equal(sheet.getRow(3).height, minHeight, '一行放得下的維持範本列高');
  // 這麼長的地址在加寬後的地點欄仍至少三行，14 號字每行約 20 點。
  assert.ok(sheet.getRow(4).height >= 59, `長地址列高應至少 59，實際 ${sheet.getRow(4).height}`);
});

test('地點、姓名換行；日期、身分證等不換行、放不下就縮字', () => {
  const sheet = sheetOf();
  assert.equal(sheet.getCell('C3').alignment.wrapText, true, '地點換行');
  assert.equal(sheet.getCell('D3').alignment.wrapText, true, '姓名換行');
  for (const address of ['A3', 'B3', 'E3', 'F3', 'G3']) {
    // 日期開了換行會在斜線處被折成兩行，第二行被切掉。
    assert.equal(sheet.getCell(address).alignment.wrapText, false, `${address} 不換行`);
    assert.equal(sheet.getCell(address).alignment.shrinkToFit, true, `${address} 放不下時縮字`);
  }
});

test('一定要寫工作表檢視設定，否則 Excel 會把每一列都縮成約三分之二高', async () => {
  const workbook = createReportWorkbook(TABLE);
  // 實際存成檔案再讀回來，確認 XML 裡真的有這兩段（ExcelJS 沒設時整段不寫）。
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.ok(reloaded.views?.length > 0, '活頁簿要有視窗設定（bookViews）');
  assert.ok(reloaded.worksheets[0].views?.length > 0, '工作表要有檢視設定（sheetViews）');
});

test('列印：寬度縮成一頁、每頁重複印標題列', () => {
  const { pageSetup } = sheetOf();
  assert.equal(pageSetup.fitToPage, true);
  assert.equal(pageSetup.fitToWidth, 1);
  assert.equal(pageSetup.fitToHeight, 0, '高度不限頁數');
  assert.equal(pageSetup.printTitlesRow, '1:2');
});

test('欄位數與資料對不上時直接中止，不產出半張表', () => {
  assert.throws(
    () => createReportWorkbook({ headers: ['編號'], rows: [['1']], problems: [] }),
    /欄位數對不上/,
  );
});

test('版面與上級發文的空白格式逐項相同', { skip: fs.existsSync(TEMPLATE_FILE) ? false : '找不到來文格式範本，略過對照' }, async () => {
  const template = new ExcelJS.Workbook();
  await template.xlsx.readFile(TEMPLATE_FILE);
  const expected = template.worksheets[0];
  const actual = sheetOf();

  assert.equal(actual.getCell('A1').value, expected.getCell('A1').value, '標題文字');
  assert.deepEqual(actual.model.merges, expected.model.merges, '合併範圍');

  for (let column = 1; column <= TRAFFIC_CASE_REPORT.columnMap.length; column += 1) {
    const label = `第 ${column} 欄`;
    assert.equal(actual.getRow(2).getCell(column).value, expected.getRow(2).getCell(column).value, `${label}的標題`);
    // 使用者要求加寬的欄位（有 templateWidth）比對的是「當初照抄的範本值」，不是現在的欄寬。
    const columnSpec = TRAFFIC_CASE_REPORT.columnMap[column - 1];
    assert.equal(
      Math.round((columnSpec.templateWidth ?? actual.getColumn(column).width) * 10) / 10,
      Math.round(expected.getColumn(column).width * 10) / 10,
      `${label}的欄寬`,
    );
    assert.equal(actual.getRow(2).getCell(column).font.name, expected.getRow(2).getCell(column).font.name, `${label}的字型`);
  }
  assert.equal(actual.getRow(1).height, expected.getRow(1).height, '標題列高');
  // 欄位列會依「醫護人員／檢傷分級」兩行字加高一點，不低於範本即可。
  assert.ok(actual.getRow(2).height >= expected.getRow(2).height, '欄位列高不低於範本');
  // 範本第 3 列起是已排好格式的空白資料列，字級與程式寫出來的要一致。
  assert.equal(actual.getRow(3).getCell(1).font.size, expected.getRow(3).getCell(1).font.size, '資料列字級');
});
