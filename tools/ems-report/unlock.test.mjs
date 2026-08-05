/**
 * 解鎖流程的測試（用假的 frame 物件，不需要真的開瀏覽器）。
 *
 * 重點同 session.test.mjs：要**實際執行到函式內部**，
 * 語法檢查抓不到「用了沒 import 的常數」，只有真的跑過才會顯現。
 *
 * 另一個重點是釘住安全行為：**比對不到相符的 TEMSIS 時絕不可以挑一張來解**。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { locateUnlockTarget, performUnlock, printUnlockSummary } from './unlock.mjs';
import { groupByRow, normalizeText } from './pageFinder.mjs';
import { getRecentRange } from './dateRange.mjs';
import { SITE } from './config.mjs';

/**
 * 造一個最小的假 page：只要能回傳一個假的內容框，
 * 且該 frame 的 evaluate() 回傳我們指定的配對結果即可。
 */
function createFakePage(pairsResult) {
  const frame = {
    name: () => SITE.frames.content,
    async evaluate() {
      return pairsResult;
    },
  };
  return { frames: () => [frame] };
}

test('案件內只有一張紀錄表時直接鎖定，不需要開紀錄表比對', async () => {
  const page = createFakePage({
    pairs: [{ recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄' }],
    recordCount: 1,
    unlockCount: 1,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => assert.fail('只有一張時不應該去開紀錄表'),
  });
  assert.equal(outcome.status, '已定位');
});

test('找不到解鎖按鈕時回報需人工處理', async () => {
  const page = createFakePage({ pairs: [], recordCount: 0, unlockCount: 0, unlockTexts: [] });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001');
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /找不到/);
});

test('有多個解鎖按鈕卻沒有可比對的紀錄表時，回報需人工處理', async () => {
  const page = createFakePage({ pairs: [], recordCount: 0, unlockCount: 3, unlockTexts: [] });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => assert.fail('沒有紀錄表可開就不該去讀'),
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /無法比對/);
});

test('多張紀錄表時，只鎖定 TEMSIS 相符的那一張', async () => {
  const page = createFakePage({
    pairs: [
      // 要逐張比對的都是「鎖住的」紀錄表；沒鎖頭那張已是未結案，另有專門的測試。
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
      { recordIndex: 2, unlockIndex: 2, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 3,
    unlockCount: 3,
    unlockTexts: [],
  });
  const sheetTemsis = ['T115070100001', 'T115070100002', 'T115070100003'];
  const outcome = await locateUnlockTarget({}, page, 'T115070100002', {
    readCodes: async (_context, _page, _texts, index) => ({
      dispatchNo: '1150701000123',
      temsis: sheetTemsis[index],
      kind: 'pdf',
    }),
  });
  assert.equal(outcome.status, '已定位');
  assert.match(outcome.detail, /第 2 張/);
  assert.match(outcome.detail, /第 2 個解鎖按鈕/);
});

test('多張紀錄表的 TEMSIS 都相符時停下來讓人看，不自己挑', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  // 兩張讀到同一個 TEMSIS：可能是序號沒生效、每次都開到同一張，這種情況不能照解。
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => ({ dispatchNo: '1150701000123', temsis: 'T115070100001', kind: 'pdf' }),
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /都相符/);
});

test('多張紀錄表都對不上時回報需人工處理，絕不隨便挑一張', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100009', {
    readCodes: async () => ({ dispatchNo: '1150701000123', temsis: 'T115070100001', kind: 'pdf' }),
  });
  assert.equal(outcome.status, '需人工處理');
});

test('TEMSIS 相符但同一列找不到解鎖按鈕時，寧可人工處理也不猜按鈕', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: -1, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: -1, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  // 只有第 1 張相符，才測得到「相符卻配不到按鈕」這條路（兩張都相符會先被另一道檢查擋下）。
  const sheetTemsis = ['T115070100001', 'T115070100002'];
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async (_context, _page, _texts, index) => ({
      dispatchNo: '1150701000123',
      temsis: sheetTemsis[index],
      kind: 'pdf',
    }),
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /同一列/);
});

/**
 * 造一個假 page 給 performUnlock 用。
 *
 * 三個成功訊號各自可以獨立控制，因為實際系統上它們**不一定同時發生**
 * （使用者 2026-08-05 遇到的正是「解鎖成功但按鈕數量沒變」）：
 *   @param {[number, number]} buttonCounts 解鎖按鈕：按之前 / 按之後
 *   @param {[number, number]} [lockedCounts] 鎖著的紀錄表張數：按之前 / 按之後
 *   @param {[boolean, boolean]} [messages] 成功訊息有沒有出現：按之前 / 按之後
 */
function createUnlockPage(buttonCounts, options = {}) {
  const {
    clickSucceeds = true,
    lockedCounts = buttonCounts,
    messages = [false, false],
  } = options;
  let clicked = false;
  const at = (pair) => (clicked ? pair[1] : pair[0]);
  const frame = {
    name: () => SITE.frames.content,
    async evaluate(_fn, params) {
      if (params.mode === 'click') {
        clicked = clickSucceeds;
        return clickSucceeds;
      }
      if (params.mode === 'pageMarkers') {
        return at(messages) ? { marker: params.markers[0], text: params.markers[0] } : null;
      }
      // 解鎖按鈕與紀錄表連結是分開查的，依查詢的文字回不同的假資料。
      const isRecords = params.texts.some((text) => text.includes('救護紀錄'));
      const count = isRecords ? at(lockedCounts) : at(buttonCounts);
      return Array.from({ length: count }, (_value, index) => ({
        index,
        tag: 'a',
        text: isRecords ? '救護紀錄(鎖)' : '調整為未結案',
        visible: true,
        rowIndex: index,
      }));
    },
  };
  return {
    frames: () => [frame],
    on() {},
    off() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
  };
}

test('解鎖後按鈕變少算成功', async () => {
  const result = await performUnlock(createUnlockPage([2, 1]), 0);
  assert.equal(result.confirmed, true);
  assert.match(result.signals.join(), /解鎖按鈕由 2 個減為 1 個/);
});

test('按鈕數量沒變，但畫面出現「已修改為未結案並解鎖」時就算成功', async () => {
  // 使用者 2026-08-05 實際遇到的情況：真的解開了，舊版卻只看按鈕而說無法確認。
  const result = await performUnlock(
    createUnlockPage([2, 2], { messages: [false, true] }),
    0,
  );
  assert.equal(result.confirmed, true);
  assert.match(result.signals.join(), /已修改為未結案並解鎖/);
});

test('按鈕數量沒變，但那一列的鎖頭不見了，也算成功', async () => {
  const result = await performUnlock(
    createUnlockPage([2, 2], { lockedCounts: [2, 1] }),
    0,
  );
  assert.equal(result.confirmed, true);
  assert.match(result.signals.join(), /鎖著的紀錄表由 2 張減為 1 張/);
});

test('本來就在畫面上的成功訊息不算數，避免把沒生效當成功', async () => {
  const result = await performUnlock(
    createUnlockPage([2, 2], { messages: [true, true] }),
    0,
  );
  assert.equal(result.confirmed, false);
});

test('三個訊號都沒動時，不可以當成解鎖成功', async () => {
  // 這種情況可能是根本沒生效（例如確認視窗被取消），必須讓使用者知道要自己確認。
  const result = await performUnlock(createUnlockPage([2, 2]), 0);
  assert.equal(result.confirmed, false);
  assert.deepEqual(result.signals, []);
});

test('按不到解鎖按鈕時要拋錯，不可以安靜地當作做完了', async () => {
  await assert.rejects(
    () => performUnlock(createUnlockPage([2, 2], { clickSucceeds: false }), 1),
    (error) => {
      assert.match(error.message, /按不到第 2 個/);
      return true;
    },
  );
});

test('groupByRow 把同一列的多個按鈕算成一筆案件', () => {
  const matches = [
    { index: 0, rowIndex: 5, text: '救護紀錄PDF', tag: 'img', visible: true },
    { index: 1, rowIndex: 5, text: '救護紀錄PDF(桃)', tag: 'img', visible: true },
    { index: 2, rowIndex: 6, text: '救護紀錄PDF', tag: 'img', visible: true },
  ];
  const groups = groupByRow(matches);
  assert.equal(groups.length, 2, '兩列＝兩筆案件');
  assert.equal(groups[0][0].index, 0, '每組第一個要是該列最前面的按鈕');
  assert.equal(groups[1][0].index, 2);
});

test('groupByRow 對不在表格內的元素各自獨立成一組', () => {
  const matches = [
    { index: 0, rowIndex: -1, text: '查詢', tag: 'img', visible: true },
    { index: 1, rowIndex: -1, text: '查詢', tag: 'img', visible: true },
  ];
  assert.equal(groupByRow(matches).length, 2);
});

test('normalizeText 去掉空白與標點並轉大寫', () => {
  assert.equal(normalizeText(' T E M S I S 編號：'), 'TEMSIS編號');
  assert.equal(normalizeText('派遣案號　：'), '派遣案號');
});

test('getRecentRange 回推兩個月且不會因大小月而算短', () => {
  const range = getRecentRange(2, new Date(2026, 6, 31)); // 2026-07-31
  assert.equal(range.start, '2026-05-31');
  assert.equal(range.end, '2026-07-31');

  // 5/31 往回兩個月＝3/31（存在），4/30 往回兩個月＝2/28（2 月沒有 30 號，夾到月底）
  assert.equal(getRecentRange(2, new Date(2026, 4, 31)).start, '2026-03-31');
  assert.equal(getRecentRange(2, new Date(2026, 3, 30)).start, '2026-02-28');
});

test('getRecentRange 跨年也要正確', () => {
  const range = getRecentRange(2, new Date(2026, 0, 15)); // 2026-01-15
  assert.equal(range.start, '2025-11-15');
  assert.equal(range.end, '2026-01-15');
});

/**
 * 一次貼上多行時，行與行之間沒有停頓，全部會在同一瞬間進入 stdin。
 * 這裡開子行程真的餵一段多行輸入，確認每一行都收得到（而不是只吃到第一行）。
 *
 * @param {string} input 餵給子行程的原始輸入
 * @returns {Promise<string[]>} promptTemsisList() 的解析結果
 */
async function collectPastedTemsis(input) {
  const { spawn } = await import('node:child_process');
  const moduleUrl = new URL('./unlock.mjs', import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(async (mod) => {
    const list = await mod.promptTemsisList();
    process.stdout.write('RESULT:' + JSON.stringify(list));
    process.exit(0);
  });`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.end(input);
  let stdout = '';
  for await (const chunk of child.stdout) stdout += chunk;
  const marker = stdout.lastIndexOf('RESULT:');
  assert.notEqual(marker, -1, `子行程沒有回報結果：${stdout}`);
  return JSON.parse(stdout.slice(marker + 'RESULT:'.length));
}

test('一次貼上多行 TEMSIS，後面幾行不可以被吃掉', async () => {
  const parsed = await collectPastedTemsis('A123\nB456\nC789\n\n');
  assert.deepEqual(parsed, ['A123', 'B456', 'C789']);
});

test('貼上的一行含多個號碼、且重複的只留一筆', async () => {
  const parsed = await collectPastedTemsis('A123 B456\nA123\nC789,D012\n\n');
  assert.deepEqual(parsed, ['A123', 'B456', 'C789', 'D012']);
});

test('其中一張紀錄表打不開時：不整筆失敗，但也不自動解鎖', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
      { recordIndex: 2, unlockIndex: 2, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 3,
    unlockCount: 3,
    unlockTexts: [],
  });
  // 第 1 張就相符，但第 2 張打不開——那張有沒有也相符無從得知，因此不能動手。
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async (_context, _page, _texts, index) => {
      if (index === 1) throw new Error('按下「救護紀錄(鎖)」後系統跳出訊息：「查無資料」，紀錄表沒有開啟');
      return { dispatchNo: '1150701000123', temsis: `T11507010000${index + 1}`, kind: 'pdf' };
    },
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /第 1 張紀錄表的 TEMSIS 相符/);
  assert.match(outcome.detail, /第 2 張打不開/);
  // 已經比對出來的線索要留著，使用者才有辦法接手人工處理。
  assert.equal(outcome.recordIndex, 0);
});

test('打得開的都不相符、另有打不開的張數時，說明要分開講', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100009', {
    readCodes: async (_context, _page, _texts, index) => {
      if (index === 1) throw new Error('60 秒內沒有出現紀錄表');
      return { dispatchNo: '1150701000123', temsis: 'T115070100001', kind: 'pdf' };
    },
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /1 張比對過的紀錄表都沒有相符/);
  assert.match(outcome.detail, /第 2 張打不開/);
});

test('全部紀錄表都打不開時，明說是打不開而不是不相符', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => { throw new Error('60 秒內沒有出現紀錄表'); },
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /全部打不開/);
});

/**
 * 造一個能控制「畫面還在不在案件內部」的假 page。
 *
 * `hasCaseDetail()` 傳給 evaluate 的參數是特徵字**陣列**，
 * 配對查詢傳的則是物件，用這點區分兩種呼叫。
 *
 * @param {boolean[]} detailStates 每次被問「還在案件內部嗎」時依序回答
 */
function createFakePageWithDetail(pairsResult, detailStates) {
  const answers = [...detailStates];
  const frame = {
    name: () => SITE.frames.content,
    async evaluate(_fn, params) {
      if (Array.isArray(params)) return answers.length > 0 ? answers.shift() : true;
      return pairsResult;
    },
  };
  return { frames: () => [frame] };
}

test('紀錄表按下去把畫面導走時，重新進入案件再繼續比對剩下幾張', async () => {
  const page = createFakePageWithDetail(
    {
      pairs: [
        { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
        { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
        { recordIndex: 2, unlockIndex: 2, recordText: '救護紀錄(鎖)' },
      ],
      recordCount: 3,
      unlockCount: 3,
      unlockTexts: [],
    },
    // 第 2 張失敗後被問到時回答「不在案件內部了」，重新進入後恢復正常。
    [false],
  );
  const opened = [];
  let reentered = 0;
  const outcome = await locateUnlockTarget({}, page, 'T115070100003', {
    readCodes: async (_context, _page, _texts, index) => {
      opened.push(index);
      if (index === 1) throw new Error('畫面就離開了案件內部，紀錄表沒有開出來');
      return { dispatchNo: '1150701000123', temsis: `T11507010000${index + 1}`, kind: 'pdf' };
    },
    reenterCase: async () => { reentered += 1; },
  });
  assert.deepEqual(opened, [0, 1, 2], '第 3 張必須照樣比對到，不能因為第 2 張失敗就停手');
  assert.equal(reentered, 1, '畫面被導走時要重新進入案件一次');
  // 第 3 張才是相符的那張，但第 2 張沒掃到，所以仍不自動解鎖。
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /第 3 張紀錄表的 TEMSIS 相符/);
  assert.match(outcome.detail, /第 2 張打不開/);
});

test('畫面被導走又回不去時，其餘幾張要記成「沒有比對到」而不是不相符', async () => {
  const page = createFakePageWithDetail(
    {
      pairs: [
        { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
        { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
        { recordIndex: 2, unlockIndex: 2, recordText: '救護紀錄(鎖)' },
      ],
      recordCount: 3,
      unlockCount: 3,
      unlockTexts: [],
    },
    [false],
  );
  const opened = [];
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async (_context, _page, _texts, index) => {
      opened.push(index);
      if (index === 1) throw new Error('畫面就離開了案件內部，紀錄表沒有開出來');
      return { dispatchNo: '1150701000123', temsis: `T11507010000${index + 1}`, kind: 'pdf' };
    },
    reenterCase: async () => { throw new Error('案件列表查不到這個派遣案號'); },
  });
  assert.deepEqual(opened, [0, 1], '回不去就不該再盲點下去');
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /第 2、3 張打不開/);
});

test('打得開的都不相符、只剩一張沒掃到時，要點出「你要的很可能是那張」', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄(鎖)' },
      { recordIndex: 2, unlockIndex: 2, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 3,
    unlockCount: 3,
    unlockTexts: [],
  });
  // 目標是第 2 張，偏偏第 2 張就是打不開的那張。
  const outcome = await locateUnlockTarget({}, page, 'T115070100002', {
    readCodes: async (_context, _page, _texts, index) => {
      if (index === 1) throw new Error('按下「救護紀錄(鎖)」後畫面就離開了案件內部');
      return { dispatchNo: '1150701000123', temsis: `T11507010000${index + 1}`, kind: 'pdf' };
    },
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /很可能就是第 2 張/);
});

test('沒有鎖頭的紀錄表不是解鎖目標：不開它，也不因此擋下定位', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄(鎖)' },
      // 實測踩到的那張：沒有鎖頭，按下去會被帶進編輯畫面而不是開 PDF。
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄' },
      { recordIndex: 2, unlockIndex: 2, recordText: '救護紀錄(鎖)' },
    ],
    recordCount: 3,
    unlockCount: 3,
    unlockTexts: [],
  });
  const opened = [];
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async (_context, _page, _texts, index) => {
      opened.push(index);
      return { dispatchNo: '1150701000123', temsis: `T11507010000${index + 1}`, kind: 'pdf' };
    },
  });
  assert.deepEqual(opened, [0, 2], '沒鎖頭那張不該去點');
  assert.equal(outcome.status, '已定位', '沒鎖頭的張數不影響能不能動手');
  assert.equal(outcome.unlockIndex, 0);
  assert.match(outcome.detail, /第 2 張沒有鎖頭/);
});

test('讀不到按鈕文字時寧可多開一張，不可以當成沒鎖頭而略過', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '' },
      { recordIndex: 1, unlockIndex: 1, recordText: undefined },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  const opened = [];
  const outcome = await locateUnlockTarget({}, page, 'T115070100002', {
    readCodes: async (_context, _page, _texts, index) => {
      opened.push(index);
      return { dispatchNo: '1150701000123', temsis: `T11507010000${index + 1}`, kind: 'pdf' };
    },
  });
  assert.deepEqual(opened, [0, 1]);
  assert.equal(outcome.status, '已定位');
});

test('整件案子都沒有鎖頭時，明說沒有需要解鎖的對象', async () => {
  const page = createFakePage({
    pairs: [
      { recordIndex: 0, unlockIndex: 0, recordText: '救護紀錄' },
      { recordIndex: 1, unlockIndex: 1, recordText: '救護紀錄' },
    ],
    recordCount: 2,
    unlockCount: 2,
    unlockTexts: [],
  });
  const outcome = await locateUnlockTarget({}, page, 'T115070100001', {
    readCodes: async () => assert.fail('沒鎖頭的都不該去點'),
  });
  assert.equal(outcome.status, '需人工處理');
  assert.match(outcome.detail, /都沒有鎖頭/);
});

test('正式解鎖後要單獨列出「這次到底動了哪幾件」', () => {
  const printed = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (text) => printed.push(String(text));
  console.error = (text) => printed.push(String(text));
  try {
    printUnlockSummary([
      {
        temsis: 'T115070100001',
        status: '已解鎖',
        detail: '第 1 張紀錄表的 TEMSIS 相符；已解鎖',
        recordIndex: 0,
        caseDate: '2026/08/01 05:05:03',
        vehicle: '中壢92',
        squad: '中壢分隊',
      },
      {
        temsis: 'T115070100009',
        status: '需人工處理',
        detail: '定位不明確',
        caseDate: '2026/08/01 09:15:33',
      },
    ], { dryRun: false });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const text = printed.join('\n');
  assert.match(text, /解鎖清單/);
  assert.match(text, /2026\/08\/01 05:05:03/, '清單要有案件日期時間');
  assert.match(text, /中壢92（中壢分隊）/, '清單要有車輛與分隊');
  assert.match(text, /第 1 張紀錄表/, '清單要說明是第幾張');
  // 沒動到的那筆不可以混進「動過的清單」裡。
  const list = text.slice(text.indexOf('解鎖清單'));
  assert.doesNotMatch(list, /09:15:33/, '沒解鎖的案件不可以出現在解鎖清單中');
});

test('試跑不會印出解鎖清單，並明說沒有任何案件被解鎖', () => {
  const printed = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (text) => printed.push(String(text));
  console.error = (text) => printed.push(String(text));
  try {
    printUnlockSummary([
      { temsis: 'T115070100001', status: '已定位', detail: '第 1 張相符', recordIndex: 0 },
    ], { dryRun: true });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const text = printed.join('\n');
  assert.doesNotMatch(text, /解鎖清單/);
  assert.match(text, /沒有任何案件被實際解鎖/);
});
