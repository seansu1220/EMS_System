/**
 * PDF 文字擷取的測試。
 *
 * 用程式現造一份最小的 PDF 來測，不放任何真實的救護紀錄表。
 * 這條路徑（PDF 位元組 → 文字 → 欄位）出問題時整個解鎖流程就抓不到案號，
 * 而且只有實際跑過才會發現 pdfjs 的 API 有沒有變（曾因 6.x 移除 document.destroy 而爆錯）。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from './pdfText.mjs';
import { extractLabeledCode } from './sheetFields.mjs';

/** 組出一份只有一頁、一行文字的合法 PDF。 */
function buildSinglePagePdf(lineText) {
  const stream = `BT /F1 12 Tf 72 720 Td (${lineText}) Tj ET`;
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]'
      + '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    `5 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += `${object}\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('extractPdfText 讀得出 PDF 內的文字，且能接著抓出欄位值', async () => {
  const bytes = buildSinglePagePdf('Dispatch No: 1150701000123');
  const text = await extractPdfText(bytes);
  assert.match(text, /1150701000123/);
  assert.equal(extractLabeledCode(text, ['Dispatch No'])?.value, '1150701000123');
});

test('extractPdfText 遇到不是 PDF 的內容要明確失敗，不能悄悄回傳空字串', async () => {
  await assert.rejects(() => extractPdfText(Buffer.from('這不是 PDF', 'utf8')));
});
