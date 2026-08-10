/**
 * 時間解析與先後比較的單元測試（純函式，不需網路與瀏覽器）。
 *
 * 這幾個函式直接決定「一件案子算不算有做到院前傳輸」，判斷錯了會讓分隊的成績
 * 莫名其妙變動，而且從報表上完全看不出來，因此把各種格式與模稜兩可的情況都釘住。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateTime, findFirstDateTime, compareUploadToArrival } from './timeParse.mjs';

const CONTEXT = { defaultYear: 2026, defaultDate: '2026-07-02' };

test('讀得懂系統各種寫法的完整日期時間', () => {
  const cases = [
    ['2026/07/02 12:44:08', Date.UTC(2026, 6, 2, 12, 44, 8)],
    ['2026-07-02 12:44:08', Date.UTC(2026, 6, 2, 12, 44, 8)],
    ['2026-07-02 12:44', Date.UTC(2026, 6, 2, 12, 44, 0)],
    ['2026年7月2日 12:44', Date.UTC(2026, 6, 2, 12, 44, 0)],
    ['2026-07-02T12:44:08', Date.UTC(2026, 6, 2, 12, 44, 8)],
    // 前後夾雜其他文字也要抓得出來（整格儲存格內容常是這樣）。
    ['上傳時間：2026/07/02 12:44:08 上傳者 王小明', Date.UTC(2026, 6, 2, 12, 44, 8)],
  ];
  for (const [text, expected] of cases) {
    const parsed = parseDateTime(text, CONTEXT);
    assert.ok(parsed, `${text} 應該解析得出來`);
    assert.equal(parsed.epochMs, expected, text);
    assert.equal(parsed.kind, 'datetime');
  }
});

test('民國年（3 碼以內）自動加 1911 換成西元', () => {
  const parsed = parseDateTime('115/07/02 12:44', CONTEXT);
  assert.equal(parsed.epochMs, Date.UTC(2026, 6, 2, 12, 44, 0));
  assert.equal(parsed.kind, 'datetime');
});

test('只有月日時（救護紀錄表 PDF 常見）用查詢月份的年份補齊', () => {
  const parsed = parseDateTime('07-02 07:32', CONTEXT);
  assert.equal(parsed.epochMs, Date.UTC(2026, 6, 2, 7, 32, 0));
  assert.equal(parsed.kind, 'monthday');
});

test('沒有給年份時，只有月日的字串不硬猜（回傳 null）', () => {
  assert.equal(parseDateTime('07-02 07:32', {}), null);
});

test('只有時分時用案件日期補齊，並標記成最容易跨日誤判的那一種', () => {
  const parsed = parseDateTime('23:50', CONTEXT);
  assert.equal(parsed.epochMs, Date.UTC(2026, 6, 2, 23, 50, 0));
  assert.equal(parsed.kind, 'timeonly');
});

test('看不出時間就回傳 null，不猜', () => {
  for (const text of ['', null, undefined, '無', '尚未上傳', '桃園分隊', '12導程心電圖']) {
    assert.equal(parseDateTime(text, CONTEXT), null, `「${text}」不該解析出時間`);
  }
});

test('數值超出合理範圍的不當成時間', () => {
  // 25 點、13 月都不是時間，多半是被誤讀的其他欄位。
  assert.equal(parseDateTime('2026-13-02 12:44', CONTEXT), null);
  assert.equal(parseDateTime('2026-07-02 25:44', CONTEXT), null);
});

test('系統的空值哨兵 0001/01/01 不是時間，要當成沒填', () => {
  // ⚠ 實跑（2026-08-11）踩到：三民分隊 7/12 那件到院時間欄就是這個值。
  //   它會被當成民國 1 年換算成 1912，於是任何上傳時間都「晚於到院」，整件判成到院後。
  for (const text of ['0001/01/01 00:00:00', '0001-01-01 00:00', '到院時間：0001/01/01 00:00:00']) {
    assert.equal(parseDateTime(text, CONTEXT), null, `「${text}」是空值哨兵，不該解析出時間`);
  }
});

test('空值哨兵當到院時間時判定不出來，不可以判成到院後', () => {
  const upload = parseDateTime('2026-07-12 16:14:14', CONTEXT);
  const arrival = parseDateTime('0001/01/01 00:00:00', CONTEXT);
  const { verdict, reason } = compareUploadToArrival(upload, arrival);
  assert.equal(verdict, '無法判定');
  assert.match(reason, /到院時間/);
});

test('findFirstDateTime 逐格找，取第一個看得懂的', () => {
  const cells = ['3', '12導程心電圖', 'ekg.pdf', '2026/07/02 12:44:08', '王小明'];
  const parsed = findFirstDateTime(cells, CONTEXT);
  assert.equal(parsed.epochMs, Date.UTC(2026, 6, 2, 12, 44, 8));
  assert.equal(findFirstDateTime(['甲', '乙'], CONTEXT), null);
});

test('上傳早於到院＝到院前，晚於＝到院後', () => {
  const arrival = parseDateTime('2026/07/02 12:44:08', CONTEXT);
  assert.equal(
    compareUploadToArrival(parseDateTime('2026/07/02 12:30:00', CONTEXT), arrival).verdict,
    '到院前',
  );
  assert.equal(
    compareUploadToArrival(parseDateTime('2026/07/02 12:50:00', CONTEXT), arrival).verdict,
    '到院後',
  );
});

test('缺任何一邊都判定不出來，而不是當成沒做', () => {
  const arrival = parseDateTime('2026/07/02 12:44:08', CONTEXT);
  assert.equal(compareUploadToArrival(null, arrival).verdict, '無法判定');
  assert.equal(compareUploadToArrival(arrival, null).verdict, '無法判定');
  assert.equal(compareUploadToArrival(null, null).verdict, '無法判定');
  // 說明要講清楚是哪一邊讀不到，使用者才知道要去看什麼。
  assert.match(compareUploadToArrival(null, arrival).reason, /上傳時間/);
  assert.match(compareUploadToArrival(arrival, null).reason, /到院時間/);
});

test('兩邊都只有時分且相差過久時判定不出來（可能跨日）', () => {
  // 23:50 上傳、隔天 00:30 到院：硬比會得出「到院後」這個完全相反的結論。
  const upload = parseDateTime('23:50', CONTEXT);
  const arrival = parseDateTime('00:30', CONTEXT);
  const result = compareUploadToArrival(upload, arrival);
  assert.equal(result.verdict, '無法判定');
  assert.match(result.reason, /跨日/);
});

test('只有時分但相差在合理範圍內時照常判定', () => {
  const upload = parseDateTime('12:30', CONTEXT);
  const arrival = parseDateTime('12:44', CONTEXT);
  assert.equal(compareUploadToArrival(upload, arrival).verdict, '到院前');
});

test('有一邊帶完整日期時就不套用跨日保護（日期已經明確）', () => {
  const upload = parseDateTime('2026/07/01 23:50', CONTEXT);
  const arrival = parseDateTime('00:30', CONTEXT);
  assert.equal(compareUploadToArrival(upload, arrival).verdict, '到院前');
});

test('兩個時間完全相同時不算到院前，交給人看', () => {
  const same = parseDateTime('2026/07/02 12:44:08', CONTEXT);
  const result = compareUploadToArrival(same, parseDateTime('2026/07/02 12:44:08', CONTEXT));
  assert.equal(result.verdict, '無法判定');
  assert.match(result.reason, /完全相同/);
});
