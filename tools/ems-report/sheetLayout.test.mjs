/**
 * Excel 版面計算的測試（純函式，不需要 Excel 也不需要瀏覽器）。
 *
 * 這些規則都是為了同一件事：**不要有文字被遮住**（使用者 2026-08-05 回報）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayWidth, excelWidthFor, computeColumnWidths, widenToFitTitle, titleWidthFor,
} from './sheetLayout.mjs';

test('中文字算兩格寬，英數算一格', () => {
  assert.equal(displayWidth('分隊'), 4);
  assert.equal(displayWidth('TEMSIS'), 6);
  assert.equal(displayWidth('第一大隊A'), 9);
  assert.equal(displayWidth(null), 0);
});

test('字級放大時，同樣的字要按比例換算成更寬的欄位', () => {
  const normal = excelWidthFor('到院前傳輸率', 11);
  const large = excelWidthFor('到院前傳輸率', 16);
  assert.ok(large > normal, `字級 16 應該比 11 寬，實際 ${large} vs ${normal}`);
});

test('欄寬要看資料列，不能只看欄名', () => {
  // 「案件日期」只有 4 個字，值卻是 19 個字元——只看欄名就會被截掉（實際踩過）。
  const header = ['分隊', '案件日期'];
  const rows = [['蘆竹分隊', '2026/07/01 09:27:02']];
  const [, dateWidth] = computeColumnWidths(header, rows, { minWidth: 10 });
  assert.ok(dateWidth >= 19, `案件日期欄至少要 19，實際 ${dateWidth}`);
});

test('沒有任何資料列時也算得出欄寬，不會變成 -Infinity', () => {
  const widths = computeColumnWidths(['分隊', 'TEMSIS'], []);
  assert.ok(widths.every((width) => Number.isFinite(width) && width > 0), widths.join(','));
});

test('指定的說明欄給固定寬度，不隨內容無限拉長', () => {
  const widths = computeColumnWidths(
    ['分隊', '說明'],
    [['蘆竹分隊', '這是一段非常非常長的說明文字'.repeat(20)]],
    { wideColumns: ['說明'], wideWidth: 60 },
  );
  assert.equal(widths[1], 60);
});

test('一般欄位有寬度上限，一列超長內容不會把整張表撐爆', () => {
  const widths = computeColumnWidths(['備註'], [['長'.repeat(200)]], { maxWidth: 40 });
  assert.equal(widths[0], 40);
});

test('合併標題放不下時要把欄位加寬（合併儲存格不會溢出，放不下就被切掉）', () => {
  const widths = widenToFitTitle([10, 10], '2026-07　有處置未勾選清冊', 14);
  const total = widths.reduce((sum, width) => sum + width, 0);
  assert.ok(total >= excelWidthFor('2026-07　有處置未勾選清冊', 14), `總寬 ${total} 不足`);
});

test('標題要留餘裕，不能剛好等於理論寬度（粗體比較寬，剛好就會被切掉）', () => {
  // ⚠ 使用者 2026-08-05、08-11 兩度回報「標題被卡到」，兩次都是因為
  //    加寬後總寬**剛好等於**理論值，而標題是粗體、實際比理論略寬。
  const title = '2026-07　有處置未勾選清冊';
  assert.ok(
    titleWidthFor(title, 14) > excelWidthFor(title, 14),
    '粗體標題的需求寬度必須大於一般字寬公式算出來的值',
  );

  const widths = widenToFitTitle([10, 10], title, 14);
  const total = widths.reduce((sum, width) => sum + width, 0);
  assert.ok(total > excelWidthFor(title, 14), `總寬 ${total} 沒有留餘裕`);
});

test('標題本來就放得下時，欄寬一格都不動', () => {
  const original = [30, 30, 30];
  assert.deepEqual(widenToFitTitle(original, '短標題', 14), original);
});

test('加寬時加在最寬的那一欄，其餘欄位維持原樣', () => {
  const widths = widenToFitTitle([10, 25], '本局7/1-7/31 12導程心電圖到院前傳輸率', 16);
  assert.equal(widths[0], 10);
  assert.ok(widths[1] > 25);
});
