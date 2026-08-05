/**
 * 解鎖救護紀錄表：把指定 TEMSIS 的案件由「已結案」調整為「未結案」。
 *
 * 流程（依使用者實際的操作步驟）：
 *   1. 報表系統 → 救護紀錄表查詢，期間設為近兩個月，填入 TEMSIS 查詢
 *   2. 開啟該筆的救護紀錄表，讀出「救災救護指揮中心指派案號」
 *   3. 報表系統 → 案件列表，期間同樣近兩個月，以指派案號查詢
 *   4. 點「救護紀錄」進入案件內部
 *   5. 只有一張紀錄表 → 那張就是目標
 *      有多張 → 逐張開啟比對 TEMSIS，只有相符的那張才是目標
 *
 * ⚠ 安全設計：**預設是試跑**（只找出目標，不按下「調整為未結案」），
 *   要真的解鎖必須明確加 `--execute`。解鎖是不可復原的寫入動作，
 *   且只有「明確定位到唯一目標」的案件才會動手，其餘一律略過。
 *
 * ⚠ 個資原則：紀錄表全文只存在記憶體，用完即棄；畫面與紀錄檔一律只顯示遮蔽後的編號末 4 碼。
 */
import {
  content,
  applyDateRange,
  applyTextCondition,
  findClickablesWithRetry,
  describeClickableOptions,
  submitQuery,
  pickFirstValue,
  hasCaseDetail,
  openCaseByDispatchNo,
} from './caseFlow.mjs';
import { UNLOCK } from './config.mjs';
import { log, prompt, startLineBuffering, stopLineBuffering } from './logger.mjs';
import { gotoRecordQuery } from './navigation.mjs';
import {
  findPageMarker,
  clickMatch,
  findPairedRows,
  readRowFields,
  groupByRow,
} from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import {
  extractLabeledCode,
  extractLabeledValue,
  listSheetLabels,
  isSameCode,
  maskCode,
} from './sheetFields.mjs';

/**
 * @typedef {Object} UnlockOutcome
 * @property {string} temsis 使用者輸入的 TEMSIS（顯示時會遮蔽）
 * @property {'已解鎖'|'已定位'|'無需處理'|'查無案件'|'需人工處理'|'失敗'} status
 *   `無需處理`＝那張紀錄表**本來就沒有鎖頭**（已是未結案），不是失敗也不必人工介入；
 *   `需人工處理`＝**真的卡住了**，程式無法判斷該解哪一張，要人接手。兩者必須分開，
 *   否則「跑得好好的」與「出問題了」會混在同一個數字裡（使用者 2026-08-06 指正）。
 * @property {string} detail 給人看的說明
 * @property {number} [unlockIndex] 目標是第幾個解鎖按鈕（0 起算）
 * @property {number} [recordIndex] 目標是第幾張紀錄表（0 起算）
 * @property {string|null} [caseDate] 案件日期（供事後追查，抓不到為 null）
 * @property {string|null} [vehicle] 該張紀錄表的派遣車輛（供事後追查，抓不到為 null）
 * @property {string|null} [squad] 該張紀錄表的派遣分隊
 */

/**
 * 從救護紀錄表查詢結果的那一列，讀出案件日期與出勤單位。
 *
 * 這是給使用者事後追查用的資訊。優先用這裡而不是 PDF：
 * 查詢結果是 HTML 表格，欄位有標題列可以對照；PDF 的文字順序則是
 * 「標題1 標題2 … 值1 值2 …」，抓標籤後面的字會抓到下一個標題（實測踩過）。
 *
 * @param {number} index 第幾個紀錄表按鈕（用來定位那一列）
 * @returns {Promise<{caseDate: string|null, vehicle: string|null, headers: string[]}>}
 */
async function readListRowInfo(page, index) {
  const row = await readRowFields(
    content(page),
    UNLOCK.buttonTexts.openRecordSheet,
    index,
    UNLOCK.listColumns.caseDate,
  ).catch(() => null);
  return {
    caseDate: pickFirstValue(row, UNLOCK.listColumns.caseDate),
    headers: row?.headers ?? [],
  };
}

/**
 * 從案件內部「要解鎖的那一列」讀出派遣車輛與派遣分隊。
 *
 * 案件內部的表格是**一列一張紀錄表**，因此讀到的正是要解鎖的那一張所屬的車輛，
 * 而不是整件案子的（一件案子可能出動兩台車）。
 *
 * @param {number} recordIndex 目標紀錄表在該頁的序號
 * @returns {Promise<{vehicle: string|null, squad: string|null, headers: string[]}>}
 */
async function readCaseRowInfo(page, recordIndex) {
  const wanted = [...UNLOCK.caseColumns.vehicle, ...UNLOCK.caseColumns.squad];
  const row = await readRowFields(
    content(page),
    UNLOCK.buttonTexts.openRecordInCase,
    recordIndex,
    wanted,
  ).catch(() => null);
  return {
    vehicle: pickFirstValue(row, UNLOCK.caseColumns.vehicle),
    squad: pickFirstValue(row, UNLOCK.caseColumns.squad),
    headers: row?.headers ?? [],
  };
}

/**
 * 開啟一張救護紀錄表，讀出指派案號與 TEMSIS。
 *
 * @param {number} index 第幾個「救護紀錄PDF」按鈕
 * @param {{exact?: boolean}} [options] 文字比對方式，**必須與算出 index 時相同**
 * @returns {Promise<{dispatchNo: string|null, temsis: string|null, kind: string}>}
 */
async function readSheetCodes(context, page, buttonTexts, index, options = {}) {
  const sheet = await openRecordSheet(context, content(page), buttonTexts, index, options);
  const dispatchNo = extractLabeledCode(sheet.text, UNLOCK.sheetLabels.dispatchNo);
  const temsis = extractLabeledCode(sheet.text, UNLOCK.sheetLabels.temsis);
  // 日期與車輛只是留給使用者事後追查的參考，抓不到不影響解鎖。
  const caseDate = extractLabeledValue(sheet.text, UNLOCK.sheetLabels.caseDate, { maxLength: 24 });
  // 車號不含空白，只取第一段，才不會把同一行的下一個欄位也吃進來。
  const vehicle = extractLabeledValue(sheet.text, UNLOCK.sheetLabels.vehicle, {
    maxLength: 16,
    singleToken: true,
  });
  log.info(`紀錄表已讀取（${sheet.kind}／${sheet.source}），共 ${sheet.text.length} 個字元`);
  return {
    dispatchNo: dispatchNo?.value ?? null,
    temsis: temsis?.value ?? null,
    caseDate: caseDate?.value ?? null,
    vehicle: vehicle?.value ?? null,
    /** 值是從哪個欄位抓來的，印在紀錄裡讓使用者能一眼判斷抓對了沒。 */
    caseDateLabel: caseDate?.label ?? null,
    vehicleLabel: vehicle?.label ?? null,
    kind: sheet.kind,
    /** 欄位抓不到時用來排查的標籤清單（只有欄位名稱，沒有內容）。 */
    availableLabels: dispatchNo && caseDate && vehicle ? [] : listSheetLabels(sheet.text),
  };
}

/**
 * 讀出「這個解鎖按鈕所在的那一列」現在是什麼狀態。
 *
 * 解鎖成功時，**按下去的那一列**的「救護紀錄(鎖)」會變成「救護紀錄」
 * （使用者 2026-08-05 描述的成功畫面）。刻意用「同一列」而不是「全頁鎖頭總數」：
 * 總數變少只能說明「有某張被解開」，不能說明**解開的是不是你按的那張**。
 * 雖然按 A 卻解開 B 幾乎不可能，但驗證本來就該驗你真正要的那件事。
 *
 * 以**解鎖按鈕的序號**當錨點：這套系統解完之後按鈕不會消失（使用者確認），
 * 因此前後兩次讀到的配對是一致的，可以直接比對同一列的文字有沒有變。
 *
 * @param {number} unlockIndex 第幾個解鎖按鈕（0 起算）
 * @returns {Promise<{recordIndex: number, recordText: string, locked: boolean}|null>}
 *   找不到對應的那一列時回傳 null（不猜）
 */
async function readTargetRecord(page, unlockIndex) {
  const paired = await findPairedRows(
    content(page),
    UNLOCK.buttonTexts.openRecordInCase,
    UNLOCK.buttonTexts.unlock,
    { recordExact: false },
  );
  const pair = paired.pairs.find((item) => item.unlockIndex === unlockIndex);
  if (!pair) return null;
  return {
    recordIndex: pair.recordIndex,
    recordText: pair.recordText,
    locked: isLockedRecord(pair.recordText),
  };
}

/**
 * 在整個頁面找「解鎖成功」的系統訊息。
 *
 * 使用者說它出現在**左上角的紅字**。這套系統是 frameset 版面，左上角可能落在
 * 上方的 header frame，也可能是內容框的最上方，因此逐個 frame 找，不預設在哪一個。
 *
 * @returns {Promise<{marker: string, text: string}|null>}
 */
async function findSuccessMessage(page) {
  for (const frame of page.frames()) {
    const found = await findPageMarker(frame, UNLOCK.successMarkers).catch(() => null);
    if (found) return found;
  }
  return null;
}

/**
 * 真的按下「調整為未結案」。
 *
 * ⚠ 這是整個工具唯一會**改動系統資料**的地方，而且無法復原。
 * 呼叫前必須已經確定目標（`locateUnlockTarget` 回報「已定位」）。
 *
 * 成功與否**看兩個訊號，任一成立就算解開了**（使用者 2026-08-05 回報：
 * 實際解鎖成功，程式卻只看按鈕數量而說「無法確認是否生效」）：
 *   1. 畫面新出現「已修改為未結案並解鎖」這類訊息 ← 最直接
 *   2. **按下去的那一列**由「救護紀錄(鎖)」變成「救護紀錄」
 *
 * 訊息必須是**按下之後才出現的**才算數：先記一次基準，本來就在畫面上的不列入。
 *
 * ⚠ 這裡**刻意不看「解鎖按鈕有沒有變少」**。使用者 2026-08-05 確認那個按鈕
 * 解完之後永遠不會消失，所以它不但驗不到東西，還會反過來製造誤判：
 * 萬一按下去之後畫面被導走（連線逾時、系統跳錯誤頁），按鈕數會從 N 掉到 0，
 * 「變少了」於是成立，一件根本沒解到的案子會被報成已解鎖。
 *
 * @param {number} unlockIndex 第幾個解鎖按鈕（0 起算）
 * @returns {Promise<{before: {recordIndex: number, recordText: string, locked: boolean}|null,
 *   after: {recordIndex: number, recordText: string, locked: boolean}|null,
 *   message: {marker: string, text: string}|null, signals: string[], confirmed: boolean}>}
 */
export async function performUnlock(page, unlockIndex) {
  const before = await readTargetRecord(page, unlockIndex);
  const messageBefore = await findSuccessMessage(page);

  // 系統很可能跳確認視窗。**Playwright 預設會自動按取消**，
  // 不自己接手的話會靜靜地什麼都沒解到，卻看起來像成功了。
  const onDialog = async (dialog) => {
    const message = dialog.message().replace(/\d{5,}/g, '#####').slice(0, 80);
    log.info(`系統跳出確認視窗：「${message}」→ 按下確定`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    const clicked = await clickMatch(content(page), UNLOCK.buttonTexts.unlock, unlockIndex);
    if (!clicked) {
      throw new Error(`按不到第 ${unlockIndex + 1} 個「${UNLOCK.buttonTexts.unlock[0]}」按鈕`);
    }
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(UNLOCK.settleMs);
  } finally {
    page.off('dialog', onDialog);
  }

  // 回讀驗證：兩個訊號各自檢查，並把成立的那幾個寫成人看得懂的說明。
  const messageAfter = await findSuccessMessage(page);
  const after = await readTargetRecord(page, unlockIndex);
  const signals = [];
  if (messageAfter && messageAfter.marker !== messageBefore?.marker) {
    signals.push(`畫面出現「${messageAfter.text || messageAfter.marker}」`);
  }
  // 只認「本來鎖著、現在沒鎖」。讀不到那一列（畫面被導走）時 after 為 null，
  // 這時不能當成解開了——不知道等於沒驗到。
  if (before?.locked && after && !after.locked) {
    signals.push(`那一列的「${before.recordText}」已變成「${after.recordText}」`);
  }
  return { before, after, message: messageAfter, signals, confirmed: signals.length > 0 };
}

/**
 * 步驟 1~2：以 TEMSIS 查到案件，開紀錄表取得指派案號。
 * @returns {Promise<{dispatchNo: string, sheetTemsis: string|null}>}
 */
async function findDispatchNoByTemsis(context, page, temsis, range) {
  log.step(`查詢救護紀錄表（TEMSIS ${maskCode(temsis)}）`);
  await gotoRecordQuery(page);
  await applyDateRange(page, range);
  await applyTextCondition(page, UNLOCK.fieldLabels.temsis, temsis, 'TEMSIS');
  await submitQuery(page);

  const buttons = await findClickablesWithRetry(page, UNLOCK.buttonTexts.openRecordSheet);
  const rows = groupByRow(buttons);
  if (rows.length === 0) {
    await captureSnapshot(context, '解鎖-救護紀錄表查詢無結果');
    throw new Error(
      '查無案件：這個 TEMSIS 在查詢期間內沒有結果，或紀錄表按鈕的文字已改變。'
        + await describeClickableOptions(page),
    );
  }
  if (rows.length > 1) {
    log.warn(`這個 TEMSIS 查到 ${rows.length} 筆案件，取第一筆處理；請自行確認是否合理`);
  }

  // 先從查詢結果那一列讀日期與出勤單位（HTML 表格有標題列可對照，比從 PDF 抓可靠）。
  const listInfo = await readListRowInfo(page, rows[0][0].index);

  const codes = await readSheetCodes(context, page, UNLOCK.buttonTexts.openRecordSheet, rows[0][0].index);
  if (!codes.dispatchNo) {
    await captureSnapshot(context, '解鎖-紀錄表讀不到指派案號');
    throw new Error(
      `紀錄表讀得到內容，但找不到「${UNLOCK.sheetLabels.dispatchNo[0]}」欄位（格式：${codes.kind}）`,
    );
  }
  // 紀錄表上讀不到 TEMSIS 的話，多張紀錄表時就無從比對，先示警讓使用者知道要調標籤。
  if (!codes.temsis) {
    log.warn(
      `紀錄表上找不到 TEMSIS 欄位（試過的標籤：${UNLOCK.sheetLabels.temsis.join('、')}）。`
        + '案件內若有多張紀錄表將無法比對，請回報以便調整標籤設定。',
    );
  }
  // 防呆：紀錄表上的 TEMSIS 應與輸入的一致，不一致代表查詢條件沒生效或點錯列。
  if (codes.temsis && !isSameCode(codes.temsis, temsis)) {
    throw new Error(
      `紀錄表上的 TEMSIS（${maskCode(codes.temsis)}）與輸入的（${maskCode(temsis)}）不符，已中止`,
    );
  }
  log.ok(`指派案號：${maskCode(codes.dispatchNo)}`);
  // 使用者要求：解鎖時要能看出這是哪一天、哪一台車的案件，供事後回頭核對。
  // 日期取自查詢結果那一列（HTML 有標題列可對照）；讀不到才退回紀錄表 PDF 抽出來的值。
  const caseDate = listInfo.caseDate ?? codes.caseDate;
  if (caseDate) {
    log.info(`案件日期：${caseDate}（取自${listInfo.caseDate ? '查詢結果' : `紀錄表的「${codes.caseDateLabel}」`}）`);
  } else {
    log.warn('讀不到案件日期，請依實際欄名調整 config.mjs 的 UNLOCK.listColumns：');
    log.info(`　查詢結果的欄位：${listInfo.headers.join('｜') || '(讀不到表格)'}`);
  }
  // 出勤車輛不在這裡讀：一件案子可能出動兩台車，要等確定解哪一張紀錄表後，
  // 才從案件內部那一列讀（見 readCaseRowInfo）。
  return { dispatchNo: codes.dispatchNo, sheetTemsis: codes.temsis, caseDate };
}

/**
 * 這張紀錄表是不是「鎖住的」（＝已結案，才有解鎖的必要）。
 *
 * 讀不到按鈕文字時一律當成鎖住的：寧可多開一張比對，也不要把真正的目標略過。
 *
 * @param {string|undefined} recordText 該張紀錄表按鈕上的文字
 * @returns {boolean}
 */
function isLockedRecord(recordText) {
  if (typeof recordText !== 'string' || recordText === '') return true;
  return recordText.includes(UNLOCK.buttonTexts.lockedRecordMarker);
}

/**
 * 步驟 5：在案件內部決定「該解哪一張紀錄表」。
 *
 * 只有一張時直接鎖定；多張時逐張開啟比對 TEMSIS，
 * **比對不到就回報需人工處理，絕不退而求其次挑一張**。
 *
 * @param {{readCodes?: typeof readSheetCodes, reenterCase?: () => Promise<void>}} [deps]
 *   `readCodes`：讀取紀錄表的方式（測試時可注入假的）。
 *   `reenterCase`：重新進入這件案子的方式。有些紀錄表按下去會把畫面導走，
 *   不先回到案件內部，後面幾張連按鈕都找不到。
 * @returns {Promise<UnlockOutcome>}
 */
export async function locateUnlockTarget(context, page, temsis, deps = {}) {
  const readCodes = deps.readCodes ?? readSheetCodes;
  const paired = await findPairedRows(
    content(page),
    UNLOCK.buttonTexts.openRecordInCase,
    UNLOCK.buttonTexts.unlock,
    { recordExact: false },
  );
  log.info(
    `案件內部：紀錄表 ${paired.recordCount} 張、`
      + `「${UNLOCK.buttonTexts.unlock[0]}」按鈕 ${paired.unlockCount} 個`,
  );
  // 把配對結果攤開來，方便核對「第幾張紀錄表配到第幾個按鈕」是否合理。
  // 一併印出每張的按鈕文字：某一張打不開時，這是判斷「它跟其他張哪裡不同」的第一線索
  // （按鈕文字屬畫面結構，不是個資）。
  if (paired.pairs.length > 0) {
    const mapping = paired.pairs
      .map((pair) => `第${pair.recordIndex + 1}張「${pair.recordText ?? '?'}」`
        + `→${pair.unlockIndex < 0 ? '同列無按鈕' : `第${pair.unlockIndex + 1}個按鈕`}`)
      .join('、');
    log.info(`  配對結果：${mapping}`);
  }

  if (paired.unlockCount === 0) {
    // 找得到紀錄表、而且每一張都沒有鎖頭 → 這件本來就是未結案，不是出問題。
    // 反之（連紀錄表都找不到）才是真的不知道發生什麼事，要人來看。
    if (paired.recordCount > 0 && paired.pairs.every((pair) => !isLockedRecord(pair.recordText))) {
      return {
        temsis,
        status: '無需處理',
        detail: `案件內 ${paired.recordCount} 張紀錄表都沒有鎖頭（已是未結案），本來就不需要解鎖`,
      };
    }
    return {
      temsis,
      status: '需人工處理',
      detail: `案件內部找不到「${UNLOCK.buttonTexts.unlock[0]}」按鈕，也看不到沒上鎖的紀錄表`
        + `（可能是按鈕文字改了）。${await describeClickableOptions(page)}`,
    };
  }
  if (paired.unlockCount === 1) {
    return {
      temsis,
      status: '已定位',
      unlockIndex: 0,
      recordIndex: paired.pairs[0]?.recordIndex ?? 0,
      detail: '案件內只有一張紀錄表，該張即為解鎖目標',
    };
  }
  if (paired.recordCount === 0) {
    // 有多個解鎖按鈕卻找不到可點開的紀錄表，就無從比對 TEMSIS，此時任何選擇都是猜的。
    return {
      temsis,
      status: '需人工處理',
      detail: `有 ${paired.unlockCount} 個解鎖按鈕，但找不到可點開的`
        + `「${UNLOCK.buttonTexts.openRecordInCase[0]}」，無法比對是哪一張。`
        + await describeClickableOptions(page),
    };
  }

  // 紀錄檔是給使用者看的，「第幾張」這種內部說法要順帶說明它代表什麼。
  log.info(`有 ${paired.recordCount} 張紀錄表，逐張開啟比對 TEMSIS`);
  log.info(`（同一件案子出動幾台車就有幾張紀錄表，逐張打開才知道你要的那筆是哪一張）`);
  // 找到相符就停下來比較快，但這樣「每一張讀到的是不是真的不同」就無從驗證
  // （若序號沒生效、每次都開到同一張，光看結果是看不出來的）。
  // 全部掃過的代價只是多開幾張，換到的是可核對的完整比對表，以及「多張相符」這種異常也能發現。
  const matches = [];
  /** 打不開的紀錄表：不能當成「不相符」，因為它有沒有相符根本不知道。 */
  const unopened = [];
  /** 沒有鎖頭的紀錄表：目前就是未結案，不是解鎖目標，不列入比對。 */
  const unlockedAlready = [];
  for (const [position, pair] of paired.pairs.entries()) {
    // 沒鎖頭那張按下去不會開 PDF，而是進入編輯畫面（畫面因此被導走）。
    // 它既然已經是未結案，就不可能是解鎖目標，開它只是白費工夫還要重新進案件。
    if (!isLockedRecord(pair.recordText)) {
      unlockedAlready.push(pair.recordIndex);
      log.info(
        `  第 ${pair.recordIndex + 1} 張：「${pair.recordText}」沒有鎖頭`
          + '，這張目前已是未結案，不是解鎖目標，略過不開',
      );
      continue;
    }
    // 文字候選與 exact 都必須與上面 findPairedRows 完全一致，否則序號會對到別張紀錄表。
    let codes;
    try {
      codes = await readCodes(
        context,
        page,
        UNLOCK.buttonTexts.openRecordInCase,
        pair.recordIndex,
        {
          exact: false,
          // 有些紀錄表按下去不是另開視窗，而是把案件內部的畫面整個換掉。
          // 這種情況再等下去也不會有紀錄表，早點收手才不會白等一分鐘。
          shouldAbort: async () => (await hasCaseDetail(page)
            ? null
            : '畫面就離開了案件內部，紀錄表沒有開出來'),
        },
      );
    } catch (error) {
      // 單張打不開就整筆放棄的話，連「已經比對出來的結果」都會一起丟掉。
      // 這裡改成記下來繼續掃，最後再依「有沒有沒掃到的」決定能不能動手。
      const reason = error instanceof Error ? error.message : String(error);
      unopened.push({ recordIndex: pair.recordIndex, reason });
      log.warn(`  第 ${pair.recordIndex + 1} 張：打不開，無法比對（${reason}）`);
      // 畫面被換掉時，後面幾張連按鈕都找不到（實跑時第 3、4 張就是這樣連環失敗），
      // 因此先回到案件內部再繼續，不然剩下的等於全部沒掃到。
      if (!(await hasCaseDetail(page))) {
        // 被導到哪去了？這是查出「這一張為什麼打不開」的關鍵線索，
        // 先把畫面上可點的東西記下來並存一份結構快照，再回頭繼續。
        log.info(`  被導走後的畫面：${await describeClickableOptions(page)}`);
        await captureSnapshot(context, '解鎖-紀錄表把畫面導走');
        const returned = deps.reenterCase
          ? await deps.reenterCase().then(() => true).catch(() => false)
          : false;
        if (!returned) {
          for (const skipped of paired.pairs.slice(position + 1)) {
            unopened.push({
              recordIndex: skipped.recordIndex,
              reason: '畫面已離開案件內部且回不去，沒有比對到',
            });
          }
          log.warn('  畫面已離開案件內部且回不去，其餘幾張都沒有比對到');
          break;
        }
        log.info('  畫面被導走，已重新進入案件內部，繼續比對下一張');
      }
      continue;
    }
    const isMatch = Boolean(codes.temsis) && isSameCode(codes.temsis, temsis);
    const shown = codes.temsis ? maskCode(codes.temsis) : '（讀不到 TEMSIS）';
    log.info(`  第 ${pair.recordIndex + 1} 張：${shown}　${isMatch ? '✅ 相符' : '不相符'}`);
    if (isMatch) matches.push(pair);
  }

  /** 打不開的張數描述，接在其他說明後面。 */
  const unopenedNote = unopened.length === 0 ? ''
    : `；另有第 ${unopened.map((item) => item.recordIndex + 1).join('、')} 張打不開`
      + `（${unopened[0].reason}）`;
  /** 略過的（沒鎖頭）張數描述。這些不影響能不能動手，但要交代清楚。 */
  const unlockedNote = unlockedAlready.length === 0 ? ''
    : `；第 ${unlockedAlready.map((index) => index + 1).join('、')} 張沒有鎖頭`
      + '（已是未結案），不是解鎖目標故未比對';
  /** 真的有拿去比對的張數。 */
  const comparedCount = paired.pairs.length - unopened.length - unlockedAlready.length;

  if (matches.length === 0) {
    if (comparedCount === 0 && unopened.length > 0) {
      return {
        temsis,
        status: '需人工處理',
        detail: `有鎖頭的紀錄表全部打不開，無法比對（${unopened[0].reason}）${unlockedNote}`,
      };
    }
    // 有鎖頭的都比對過了、沒有一張相符，而且沒有漏掉任何一張沒掃到的——
    // 那麼你要的那張只可能落在「本來就沒鎖」的那幾張裡面（案號是用這個 TEMSIS 查出來的，
    // 案件不會錯）。這是**不需要處理**，不是卡住了（使用者 2026-08-06 指正）。
    if (unopened.length === 0 && unlockedAlready.length > 0) {
      const shownIndexes = unlockedAlready.map((index) => index + 1).join('、');
      return {
        temsis,
        status: '無需處理',
        detail: comparedCount === 0
          ? '這件案子的紀錄表都沒有鎖頭（已是未結案），本來就不需要解鎖'
          : `有鎖頭的 ${comparedCount} 張都比對過、沒有一張相符，`
            + `其餘第 ${shownIndexes} 張本來就沒有鎖頭（已是未結案）`
            + '——你要的那張就在其中，不需要解鎖',
      };
    }
    // 比對過的都不是，又剛好只剩一張沒掃到——那張幾乎就是要找的目標。
    // 仍然不動手（沒親眼比對過就不算數），但要把這個判斷講出來，人才好接手。
    const likelyNote = unopened.length === 1
      ? `。比對過的都不是，因此你要的很可能就是第 ${unopened[0].recordIndex + 1} 張，請自行到系統確認`
      : '';
    return {
      temsis,
      status: '需人工處理',
      detail: `${comparedCount} 張比對過的紀錄表都沒有相符的 TEMSIS`
        + `${unopenedNote}${unlockedNote}${likelyNote}`,
    };
  }
  if (matches.length > 1) {
    // 同一件案子裡兩張紀錄表有相同的 TEMSIS 並不合理，寧可停下來讓人看。
    return {
      temsis,
      status: '需人工處理',
      detail: `有 ${matches.length} 張紀錄表的 TEMSIS 都相符`
        + `（第 ${matches.map((pair) => pair.recordIndex + 1).join('、')} 張），無法判斷該解哪一張`,
    };
  }

  const target = matches[0];
  if (target.unlockIndex < 0) {
    return {
      temsis,
      status: '需人工處理',
      recordIndex: target.recordIndex,
      detail: `第 ${target.recordIndex + 1} 張紀錄表的 TEMSIS 相符，`
        + '但同一列裡沒有解鎖按鈕，無法確定該按哪一個（不猜，請人工處理）',
    };
  }
  if (unopened.length > 0) {
    // 只有一張相符，但還有沒掃到的張數——萬一那張也相符，動手就是解錯張。
    // 目標仍照實回報（含車輛與日期），讓使用者可以自行到系統核對後手動處理。
    return {
      temsis,
      status: '需人工處理',
      recordIndex: target.recordIndex,
      detail: `第 ${target.recordIndex + 1} 張紀錄表的 TEMSIS 相符`
        + `（對應第 ${target.unlockIndex + 1} 個解鎖按鈕）`
        + `${unopenedNote}，無法確認沒有第二張也相符，因此不自動解鎖`,
    };
  }
  return {
    temsis,
    status: '已定位',
    unlockIndex: target.unlockIndex,
    recordIndex: target.recordIndex,
    detail: `第 ${target.recordIndex + 1} 張紀錄表的 TEMSIS 相符，`
      + `對應同一列的第 ${target.unlockIndex + 1} 個解鎖按鈕${unlockedNote}`,
  };
}

/**
 * 定位成功後，真的按下解鎖並確認結果。
 * @param {UnlockOutcome} outcome 會被就地補上解鎖後的狀態
 */
async function unlockLocatedTarget(page, outcome) {
  const caseInfo = `${outcome.caseDate ?? '日期讀不到'}　`
    + `${outcome.vehicle ?? outcome.squad ?? '車輛讀不到'}`;
  log.step(`按下「${UNLOCK.buttonTexts.unlock[0]}」（${caseInfo}）`);
  const result = await performUnlock(page, outcome.unlockIndex);

  if (result.confirmed) {
    outcome.status = '已解鎖';
    outcome.detail = `${outcome.detail}；已解鎖（${result.signals.join('；')}）`;
    log.ok(`已解鎖：${caseInfo}　TEMSIS ${maskCode(outcome.temsis)}`);
    log.info(`　依據：${result.signals.join('；')}`);
    return;
  }
  // 兩個訊號都沒成立：可能真的沒生效，也可能系統換了訊息或版面。不臆測，如實回報，
  // 並把「各項訊號分別是什麼狀況」寫出來，使用者一看就知道要調哪個設定。
  const rowState = result.after
    ? `那一列仍寫著「${result.after.recordText}」`
    : '按完之後找不到那一列（畫面可能被導走了）';
  outcome.status = '需人工處理';
  outcome.detail = `${outcome.detail}；已按下按鈕，但兩項成功訊號都沒出現`
    + `（沒看到「${UNLOCK.successMarkers[0]}」的訊息、${rowState}），`
    + '無法確認是否生效，請自行到系統確認';
  log.warn(`${maskCode(outcome.temsis)}：${outcome.detail}`);
}

/**
 * 處理一筆 TEMSIS。
 * @param {{dryRun: boolean}} options dryRun＝true 時只定位，不按下解鎖
 * @returns {Promise<UnlockOutcome>}
 */
async function processTemsis(context, page, temsis, range, options) {
  try {
    const caseInfo = await findDispatchNoByTemsis(context, page, temsis, range);
    await openCaseByDispatchNo(context, page, caseInfo.dispatchNo, range);
    const outcome = await locateUnlockTarget(context, page, temsis, {
      // 走同一條路重新查一次案件；比對到一半畫面被導走時才用得到。
      reenterCase: () => openCaseByDispatchNo(context, page, caseInfo.dispatchNo, range),
    });
    outcome.caseDate = caseInfo.caseDate;
    // 「無需處理」是正常結果，不該用警告的樣子出現在紀錄裡。
    if (outcome.status === '已定位') log.ok(`${maskCode(temsis)}：${outcome.detail}`);
    else if (outcome.status === '無需處理') log.info(`${maskCode(temsis)}：${outcome.detail}`);
    else log.warn(`${maskCode(temsis)}：${outcome.detail}`);

    // 確定是哪一張之後，才讀得到「那一張」所屬的車輛（一件案子可能出動兩台車）。
    // 只要知道是哪一列就讀，「需人工處理」也一樣——那正是使用者要拿去人工核對的線索。
    if (typeof outcome.recordIndex === 'number' && outcome.recordIndex >= 0) {
      const caseRow = await readCaseRowInfo(page, outcome.recordIndex);
      outcome.vehicle = caseRow.vehicle;
      outcome.squad = caseRow.squad;
      if (caseRow.vehicle || caseRow.squad) {
        log.info(`出勤車輛：${caseRow.vehicle ?? '（讀不到）'}　派遣分隊：${caseRow.squad ?? '（讀不到）'}`);
      } else {
        log.warn('讀不到出勤車輛，請依實際欄名調整 config.mjs 的 UNLOCK.caseColumns：');
        log.info(`　案件內部表格的欄位：${caseRow.headers.join('｜') || '(讀不到表格)'}`);
      }
    }

    // 只有明確定位到目標才會動手；其餘狀態一律略過，交給人處理。
    if (outcome.status === '已定位' && !options.dryRun) {
      await unlockLocatedTarget(page, outcome);
    }
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.fail(`處理 TEMSIS ${maskCode(temsis)}`, error);
    return {
      temsis,
      status: reason.startsWith('查無案件') ? '查無案件' : '失敗',
      detail: reason,
    };
  }
}

/**
 * 在終端機請使用者貼上 TEMSIS。
 *
 * 一行一個，也接受一行貼多個（以空白或逗號分隔）；空白行代表輸入結束。
 * @returns {Promise<string[]>} 去除重複後的清單
 */
export async function promptTemsisList() {
  log.step('請貼上要解鎖的 TEMSIS 編號');
  log.info('可以一次貼上整欄（多行一起貼沒問題），也可以一行貼一個再按 Enter。');
  log.info('全部貼完後，在「空白的那一行」再按一次 Enter，才會開始執行。');
  log.info('（只有一筆的話就是：貼上 → Enter → 再按一次 Enter）');
  log.info('貼不上去時：在黑色視窗內按「滑鼠右鍵」就是貼上（Ctrl+V 常被輸入法吃掉）。');
  /** @type {string[]} */
  const collected = [];
  // 一次貼上整欄號碼時，多出來的行會在兩次 prompt 之間到達，必須先開緩衝才不會漏。
  await startLineBuffering();
  try {
    for (;;) {
      // 提示字串刻意維持**短且純 ASCII**：Windows 傳統主控台（conhost）上，
      // readline 按下 Enter 後會依提示字寬重繪該行，提示含全形字或整行過長時
      // 會把剛輸入的內容抹掉——讀是讀到了，但使用者看不到自己貼了什麼。
      const line = await prompt(`  [${collected.length + 1}] `);
      // null 代表輸入串流結束（EOF），空字串代表使用者按了 Enter，兩者都視為輸入完畢。
      if (line === null || line === '') break;
      collected.push(...line.split(/[\s,，;；]+/).filter(Boolean));
      // 上面那行可能被主控台抹掉，因此另外印一行回條，讓使用者確定收到了幾筆。
      log.info(`已收到 ${collected.length} 筆`);
    }
  } finally {
    stopLineBuffering();
  }
  return [...new Set(collected)];
}

/**
 * 解鎖流程主入口。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {{temsisList: string[], range: import('./dateRange.mjs').MonthRange,
 *   dryRun?: boolean}} options dryRun＝true 時只定位、不解鎖
 * @returns {Promise<UnlockOutcome[]>}
 */
export async function runUnlockFlow(session, options) {
  const { temsisList, range, dryRun = false } = options;
  if (dryRun) {
    log.step(`試跑模式：只找出「該解哪一張」，不會按下「${UNLOCK.buttonTexts.unlock[0]}」`);
  } else {
    log.step(`正式模式：定位到目標後會**實際按下**「${UNLOCK.buttonTexts.unlock[0]}」`);
    log.info('定位不明確的案件一律略過，不會亂解。每筆都會記下案件日期與出勤車輛供事後核對。');
  }
  log.info(`查詢期間：${range.start} ~ ${range.end}（${range.label}）`);
  log.info(`共 ${temsisList.length} 筆 TEMSIS 要處理`);

  /** @type {UnlockOutcome[]} */
  const outcomes = [];
  for (const [position, temsis] of temsisList.entries()) {
    log.step(`第 ${position + 1} / ${temsisList.length} 筆：${maskCode(temsis)}`);
    outcomes.push(await processTemsis(session.context, session.page, temsis, range, { dryRun }));
  }
  return outcomes;
}

/**
 * 把結果整理成終端機摘要。
 *
 * 每一列都帶上案件日期與出勤車輛：使用者無法逐筆人工比對，
 * 這份紀錄是他日後回頭查「到底解了哪些案件」的唯一依據（使用者 2026-07-31 指定）。
 */
export function printUnlockSummary(outcomes, options = {}) {
  log.step('執行結果');
  // 日期與車輛擺在最前面：這是使用者事後回頭追查案件時最先要找的兩個欄位。
  const pad = (text, width) => {
    const value = String(text ?? '');
    // 中文字在終端機約佔兩個字元寬，補空白時要算進去才對得齊。
    const displayWidth = [...value].reduce((sum, char) => sum + (/[一-龥]/.test(char) ? 2 : 1), 0);
    return value + ' '.repeat(Math.max(0, width - displayWidth));
  };
  for (const outcome of outcomes) {
    // 車輛後面附上分隊（例如「平鎮92（平鎮分隊）」），事後回頭找案件比較好認。
    const vehicle = outcome.vehicle
      ? `${outcome.vehicle}${outcome.squad ? `（${outcome.squad}）` : ''}`
      : outcome.squad ?? '車輛讀不到';
    const line = `${pad(outcome.caseDate ?? '日期讀不到', 22)}${pad(vehicle, 20)}`
      + `${maskCode(outcome.temsis)}　${outcome.status}　${outcome.detail}`;
    if (outcome.status === '已解鎖' || outcome.status === '已定位') log.ok(line);
    // 「無需處理」是正常結果（那張本來就沒鎖），用一般訊息呈現，不擺成警告。
    else if (outcome.status === '無需處理') log.info(line);
    else log.warn(line);
  }

  const countOf = (status) => outcomes.filter((item) => item.status === status).length;
  const unlocked = countOf('已解鎖');
  const located = countOf('已定位');
  const noAction = countOf('無需處理');
  // 「需要人接手的」＝扣掉成功的、也扣掉本來就沒鎖的。這個數字才代表「有問題」，
  // 混進「本來就沒鎖」會讓一次順利的執行看起來像是出了狀況（使用者 2026-08-06 指正）。
  const needsAttention = outcomes.length - unlocked - located - noAction;
  const noActionNote = noAction > 0 ? `、本來就沒鎖 ${noAction} 筆（不需動作）` : '';

  if (options.dryRun) {
    log.info(
      `共 ${outcomes.length} 筆：定位成功 ${located} 筆${noActionNote}`
        + `、需要你接手 ${needsAttention} 筆`,
    );
    log.warn('本次為試跑，沒有任何案件被實際解鎖。');
    return;
  }
  log.info(
    `共 ${outcomes.length} 筆：已解鎖 ${unlocked} 筆${noActionNote}`
      + `、需要你接手 ${needsAttention} 筆`,
  );
  printUnlockedList(outcomes);
  if (needsAttention > 0) {
    log.warn(`有 ${needsAttention} 筆程式無法判斷，請自行到系統處理（原因見上方每一列的說明）。`);
  }
}

/**
 * 把「這次到底動了哪幾件」單獨列成一張清單。
 *
 * 上面那張表混著各種狀態、說明又長，實際解掉的幾筆容易被淹沒；
 * 這張只列動過的，是事後回系統核對用的依據。
 *
 * @param {UnlockOutcome[]} outcomes
 */
function printUnlockedList(outcomes) {
  const unlocked = outcomes.filter((item) => item.status === '已解鎖');
  if (unlocked.length === 0) {
    log.warn('這次沒有任何案件被實際解鎖。');
    return;
  }
  log.step(`解鎖清單（實際按下「${UNLOCK.buttonTexts.unlock[0]}」的有 ${unlocked.length} 筆）`);
  for (const [position, outcome] of unlocked.entries()) {
    const vehicle = outcome.vehicle
      ? `${outcome.vehicle}${outcome.squad ? `（${outcome.squad}）` : ''}`
      : outcome.squad ?? '車輛讀不到';
    const sheet = typeof outcome.recordIndex === 'number' && outcome.recordIndex >= 0
      ? `第 ${outcome.recordIndex + 1} 張紀錄表`
      : '紀錄表張次不明';
    log.info(
      `${position + 1}. ${outcome.caseDate ?? '日期讀不到'}　${vehicle}　${sheet}`
        + `　TEMSIS ${maskCode(outcome.temsis)}`,
    );
  }
  log.info('以上是這次唯一被修改的案件，請自行到系統核對。');
}
