/**
 * 上傳清單內容判讀的測試。
 *
 * 釘住的是兩條會直接改動報表數字的規則：
 *   1. 「是不是 12 導程」**只看檔案類型欄**，備註寫什麼都不算
 *      （2026-08-05 使用者指正過一次的錯，不可以再犯）
 *   2. 「備註算不算補述原因」要排掉 ZOLL 自動填的樣板字，
 *      否則所有 ZOLL 自動上傳又到院後才傳的案件全部會補進分子，
 *      「到院後」這個判定等於失效
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_KIND,
  bytesToText,
  classifyFileRows,
  fileExtension,
  inspectMediaFile,
  isMeaningfulRemark,
  looksLikeTwelveLead,
  mediaHandling,
} from './ekgMedia.mjs';
import { EKG } from './config.mjs';

const row = (fileType, options = {}) => ({
  fileType,
  uploadTime: options.uploadTime ?? '2026/07/06 12:40:45',
  remark: options.remark ?? '',
  links: options.links ?? [{ text: options.fileName ?? 'CHFD_1.json', href: 'https://x/y/CHFD_1.json' }],
});

test('副檔名：取最後一個點之後，網址帶查詢字串也要切乾淨', () => {
  assert.equal(fileExtension('CHFD_123.JPG'), 'jpg');
  assert.equal(fileExtension('a.b.pdf'), 'pdf');
  assert.equal(fileExtension('/download/2026/07/9/x.json?v=2'), 'json');
  assert.equal(fileExtension('沒有副檔名'), '');
  assert.equal(fileExtension('結尾是點.'), '');
});

test('分類只看「檔案類型」欄——備註寫著 12導程 不算數', () => {
  // ⚠ 這正是使用者 2026-08-05 指正的那個坑：備註「ZOLL12導程附檔上傳(JSON檔)」
  //   會讓檔案類型根本不是 12 導程的列被誤算成有做。
  const rows = [
    row('12導程心電圖'),
    row('其他', { remark: 'ZOLL12導程附檔上傳(JSON檔)' }),
    row('案件影音', { fileName: 'IMG_1.jpg' }),
    row('到院前OHCA心電圖'),
  ];
  const { twelveLead, media, others } = classifyFileRows(rows, EKG.verify);

  assert.equal(twelveLead.length, 1);
  assert.equal(twelveLead[0].fileType, '12導程心電圖');
  assert.equal(media.length, 1);
  assert.equal(media[0].fileType, '案件影音');
  assert.equal(others.length, 2, '其他與 OHCA 心電圖都不算 12 導程');
});

test('備註：純 ZOLL 樣板字不算補述，後面接了人話才算', () => {
  assert.equal(isMeaningfulRemark('ZOLL介接心電圖'), false);
  assert.equal(isMeaningfulRemark('ZOLL12導程附檔上傳(JSON檔)'), false);
  assert.equal(isMeaningfulRemark('ZOLL介接心電圖，現場無訊號延後上傳'), true);
  assert.equal(isMeaningfulRemark('設備故障'), true);
});

test('備註：空白、標點、太短的都不算補述', () => {
  assert.equal(isMeaningfulRemark(''), false);
  assert.equal(isMeaningfulRemark('   '), false);
  assert.equal(isMeaningfulRemark('.'), false);
  assert.equal(isMeaningfulRemark('（）、。'), false);
  assert.equal(isMeaningfulRemark('壞'), false, '一個字不足以當理由');
});

test('備註：檔案類型是案件影音時視為人寫的，不套樣板過濾', () => {
  // 使用者 2026-09-21 說明：會選到「案件影音」就代表是人自己上傳、自己打的字，
  // 設備自動傳的一律落在「12導程心電圖」那個類型。
  assert.equal(isMeaningfulRemark('ZOLL介接心電圖', EKG.verify.remark), false);
  assert.equal(
    isMeaningfulRemark('ZOLL介接心電圖', EKG.verify.remark, { trustAsHuman: true }),
    true,
  );
});

test('內容判讀：直接寫著 12 導程字樣就算數', () => {
  assert.equal(looksLikeTwelveLead('12導程心電圖 報告').is, true);
  assert.equal(looksLikeTwelveLead('12-Lead ECG Report').is, true);
  assert.equal(looksLikeTwelveLead('12 LEAD').is, true, '中間有空白的寫法也要認得');
});

test('內容判讀：湊滿四個導程名稱才算，少於四個一律不斷定', () => {
  assert.equal(looksLikeTwelveLead('{"leads":["aVR","aVL","aVF","V1"]}').is, true);
  const 三個 = looksLikeTwelveLead('版本 V1 V2 V3');
  assert.equal(三個.is, false);
  assert.match(三個.why, /不足/, '判不出來時要說得出為什麼');
});

test('內容判讀：抽不出文字要明講，不可以當成「不是心電圖」就算了', () => {
  const result = looksLikeTwelveLead('');
  assert.equal(result.is, false);
  assert.match(result.why, /抽不出/);
});

test('依副檔名決定怎麼處理：圖片不猜、影音不抓、沒見過的先試試看', () => {
  assert.equal(mediaHandling('a.jpg'), 'image');
  assert.equal(mediaHandling('a.PNG'), 'image');
  assert.equal(mediaHandling('a.mp4'), 'skip');
  assert.equal(mediaHandling('a.pdf'), 'text');
  assert.equal(mediaHandling('a.json'), 'text');
  assert.equal(mediaHandling('a.什麼鬼'), 'text', '沒見過的格式先試著讀，不要直接放棄');
});

test('bytesToText：非 PDF 直接當 UTF-8 讀', async () => {
  const text = await bytesToText(Buffer.from('{"lead":"aVR"}', 'utf8'), 'x.json');
  assert.equal(text, '{"lead":"aVR"}');
});

/** 假的 Playwright APIRequestContext，讓判讀流程能離線測試。 */
const fakeRequest = (response) => ({
  get: async () => response,
});
const okResponse = (body, headers = {}) => ({
  ok: () => true,
  status: () => 200,
  headers: () => headers,
  body: async () => Buffer.from(body, 'utf8'),
});

test('圖片一律回「程式讀不出內容」，絕不自己猜', async () => {
  // 猜的話兩種錯都會發生：把現場照片當成心電圖而灌水，
  // 或把心電圖照片漏掉而讓分隊掉一件。使用者 2026-09-21 選擇列清單人工看。
  const result = await inspectMediaFile(fakeRequest(null), { text: 'IMG_1.jpg', href: 'https://x/IMG_1.jpg' });
  assert.equal(result.kind, MEDIA_KIND.unreadable);
  assert.match(result.why, /點開看/);
});

test('影片連抓都不抓，直接判不是心電圖', async () => {
  const result = await inspectMediaFile(fakeRequest(null), { text: 'a.mp4', href: 'https://x/a.mp4' });
  assert.equal(result.kind, MEDIA_KIND.notEcg);
});

test('JSON 裡有四個導程名稱就判成 12 導程', async () => {
  const body = JSON.stringify({ channels: ['aVR', 'aVL', 'aVF', 'V1', 'V2'] });
  const result = await inspectMediaFile(
    fakeRequest(okResponse(body)),
    { text: 'CHFD_1.json', href: 'https://x/CHFD_1.json' },
  );
  assert.equal(result.kind, MEDIA_KIND.twelveLead);
});

test('抓得回來但不是心電圖的，就是不是', async () => {
  const result = await inspectMediaFile(
    fakeRequest(okResponse('現場交通事故說明文字')),
    { text: 'note.txt', href: 'https://x/note.txt' },
  );
  assert.equal(result.kind, MEDIA_KIND.notEcg);
});

test('抓不回來要回「讀取失敗」，不可以默默當成沒做', async () => {
  // 讀取失敗會進待人工確認清單；判成「不是心電圖」則是永久把一件案子判死。
  const result = await inspectMediaFile(
    fakeRequest({ ok: () => false, status: () => 403, headers: () => ({}), body: async () => Buffer.alloc(0) }),
    { text: 'a.json', href: 'https://x/a.json' },
  );
  assert.equal(result.kind, MEDIA_KIND.failed);
  assert.match(result.why, /403/);
});

test('連線爆掉也是「讀取失敗」，不是「不是心電圖」', async () => {
  const request = { get: async () => { throw new Error('socket hang up'); } };
  const result = await inspectMediaFile(request, { text: 'a.json', href: 'https://x/a.json' });
  assert.equal(result.kind, MEDIA_KIND.failed);
  assert.match(result.why, /socket hang up/);
});

test('超過大小上限的不抓進記憶體，當成影音', async () => {
  const huge = okResponse('x', { 'content-length': String(EKG.verify.media.maxBytes + 1) });
  const result = await inspectMediaFile(fakeRequest(huge), { text: 'a.dat', href: 'https://x/a.dat' });
  assert.equal(result.kind, MEDIA_KIND.notEcg);
  assert.match(result.why, /上限/);
});

test('沒有網址的那一列回「讀取失敗」，不會拿 undefined 去抓', async () => {
  const result = await inspectMediaFile(fakeRequest(null), { text: 'a.json', href: '' });
  assert.equal(result.kind, MEDIA_KIND.failed);
});
