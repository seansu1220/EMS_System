/**
 * 裝置管理重置：把狀態卡在「持續取得資料」的裝置先「鎖定」、再「啟用」。
 *
 * ## 什麼時候用得到
 * 裝置狀態停在「持續取得資料」時，分隊的紀錄表會一直被那台裝置佔著改不了。
 * 人工的處理方式是（使用者 2026-10-29 指定）：
 *   系統設定 → 裝置管理 → 狀態是「持續取得資料」的那一列按「鎖定」
 *   → 該列狀態變成「管理者停用」→ 同一列再按「啟用」
 *
 * 線上解鎖工具在**每次剛登入後**自動做一輪：常駐監看開啟時、掉線重新登入後、
 * 一次性的線上解鎖工單處理完之後、值班監看。另有 `device-reset` 指令可單獨跑（預設試跑）。
 *
 * ## 台數可能很多
 * 第一次試跑就有 133 台（使用者確認確實都是異常），一台要整頁重送兩次、實測約 6 秒，
 * 一整輪約 14 分鐘。因此：
 * - 每做完一台就呼叫 `betweenDevices`，讓監看有機會先處理新的解鎖申請（使用者 2026-10-29 選定）
 * - 每台之間檢查 `shouldStop`，關視窗時停在兩台之間，**不會停在鎖定與啟用之間**
 * - 畫面上找不到清單（多半是掉線）就中止這一輪，剩下的等下次登入
 *
 * ## 最怕的不是按錯，是「鎖了沒啟用」
 * 鎖定之後若沒能啟用，那台裝置就停在管理者停用、分隊完全不能用。所以：
 * - 一次只處理一台，**鎖定與啟用緊接著做**，不是全部鎖完再全部啟用
 * - 啟用沒成功一律大聲回報「這台停在管理者停用，請手動按啟用」
 *
 * ## 是哪一列：靠裝置ID
 * 清單每列都有「裝置ID」，鎖定／啟用鈕的 `onclick` 也自帶該列的裝置ID（2026-10-29 探測）。
 * 認列用裝置ID，按下前再確認按鈕自己寫著同一個裝置ID（見 `pageFinder.mjs` 的 `statusRows` 模式）。
 * 裝置ID 只在頁面裡算成短碼帶出來；畫面上只顯示分隊與末 4 碼，使用者姓名一律不帶出。
 */
import { content } from './caseFlow.mjs';
import { UNLOCK } from './config.mjs';
import { log } from './logger.mjs';
import { gotoMenuItem } from './navigation.mjs';
import { clickStatusRowButton, findStatusRows } from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';

/**
 * @typedef {import('./pageFinder.mjs').StatusRow} StatusRow
 */

/**
 * @typedef {Object} DeviceResetOutcome 一台裝置的處理結果
 * @property {number} rowIndex 清單上的第幾列（僅供人核對）
 * @property {string|null} label 單位（讀不到為 null）
 * @property {string|null} idTail 裝置ID 末 4 碼
 * @property {'已重置'|'會重置'|'無需處理'|'需人工處理'} status
 *   `會重置`＝試跑模式下找到了這一台，沒有動手；
 *   `無需處理`＝輪到它的時候已經不是「持續取得資料」了（自己恢復或有人處理過）
 * @property {string} detail 給人看的說明
 * @property {boolean} leftDisabled 這台是否**可能停在管理者停用**（鎖了但沒確認啟用），需要人立刻處理
 */

/**
 * @typedef {Object} DeviceResetOptions
 * @property {boolean} dryRun true 時只回報會處理哪幾台，**不動手**
 * @property {() => Promise<boolean>} [betweenDevices] 每做完一台呼叫一次（給監看穿插處理解鎖申請）；
 *   回傳 true 代表它把畫面帶走了，要重新打開裝置管理
 * @property {() => boolean} [shouldStop] 回傳 true 時停在兩台之間
 */

/**
 * @typedef {Object} DeviceResetSummary 一輪重置的總結
 * @property {number} scanned 清單掃了幾列
 * @property {number} stuckCount 一開始有幾台是「持續取得資料」
 * @property {DeviceResetOutcome[]} outcomes 每台卡住裝置的結果
 * @property {string|null} stoppedReason 沒做完就停下的理由（收到結束指示、畫面找不到清單…）
 */

/** 組出頁面端查詢要用的欄位設定（全部來自 `UNLOCK.deviceReset`）。 */
function statusRowQuery() {
  const {
    statusColumns, identityColumns, labelColumns, labelSeparator,
    volatileHeaderKeywords, buttonTexts, maxRows,
  } = UNLOCK.deviceReset;
  return {
    statusColumns, identityColumns, labelColumns, labelSeparator,
    volatileHeaderKeywords, buttonTexts, maxRows,
  };
}

/** 狀態文字是否屬於某一組（忽略空白，以「包含」比對）。 */
export function statusMatches(status, candidates) {
  const compact = String(status ?? '').replace(/[\s　]+/g, '');
  return candidates.some((candidate) => compact.includes(candidate.replace(/[\s　]+/g, '')));
}

/** 「第 N 列（中路分隊，裝置ID 末4碼 3B12）」：畫面與紀錄檔上指稱某一台的寫法。 */
export function describeDevice(row) {
  const tail = row.idTail ? `，裝置ID 末4碼 ${row.idTail}` : '';
  return `第 ${row.rowIndex} 列（${row.label ?? '讀不到單位'}${tail}）`;
}

/** 一台裝置的結果物件（只帶可對外顯示的欄位）。 */
function makeOutcome(row, status, detail, leftDisabled = false) {
  return { rowIndex: row.rowIndex, label: row.label, idTail: row.idTail ?? null, status, detail, leftDisabled };
}

/**
 * 從掃描結果挑出這一輪要處理的裝置（純函式，不碰瀏覽器，方便測試）。
 *
 * @param {{rows: StatusRow[]}} scan
 * @param {{stuck: string[]}} statusValues
 * @returns {{targets: StatusRow[], skipped: {row: StatusRow, why: string}[]}}
 */
export function pickStuckDevices(scan, statusValues) {
  const targets = [];
  const skipped = [];
  for (const row of scan.rows) {
    if (!statusMatches(row.status, statusValues.stuck)) continue;
    if (!row.unique) {
      // 認不出唯一的一列，就沒辦法在鎖定之後找回它去按啟用——寧可不鎖。
      skipped.push({ row, why: '清單裡有別列的裝置ID 跟它一樣（或讀不到裝置ID），無法確定按的是同一台' });
    } else if (!row.buttons.lock) {
      skipped.push({ row, why: '那一列裡找不到自帶這台裝置ID 的「鎖定」按鈕' });
    } else {
      targets.push(row);
    }
  }
  return { targets, skipped };
}

/**
 * 把 `clickStatusRowButton` 沒動手的理由翻成人話。
 * @param {string|undefined} reason
 */
export function describeDeviceClickRefusal(reason) {
  if (reason === 'noTable') return '畫面上找不到裝置清單（可能被導走或掉線了）';
  if (reason === 'notFound') return '要按的時候那一列已經不在了（可能畫面重整過）';
  if (reason === 'notUnique') return '要按的時候變成多列相符，為安全起見沒有動手';
  if (reason === 'statusChanged') return '要按的時候那一列的狀態已經不是預期的了';
  if (reason === 'noButton') return '要按的時候那一列裡找不到自帶這台裝置ID 的按鈕';
  return `沒有動手（${reason ?? '原因不明'}）`;
}

/** 依台數估計要多久（給人心裡有數，不是承諾）。 */
export function estimateMinutes(deviceCount, msPerDevice = UNLOCK.deviceReset.estimatedMsPerDevice) {
  return Math.max(1, Math.ceil((deviceCount * msPerDevice) / 60000));
}

/**
 * 等清單真的出現（找得到狀態欄的表格才算載完）。
 * @returns {Promise<Awaited<ReturnType<typeof findStatusRows>>|null>} 逾時回傳 null
 */
async function waitForDeviceTable(page) {
  const deadline = Date.now() + UNLOCK.deviceReset.pageTimeoutMs;
  while (Date.now() < deadline) {
    const scan = await findStatusRows(content(page), statusRowQuery()).catch(() => null);
    if (scan?.found) return scan;
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * 導向「系統設定 → 裝置管理」並讀出清單。
 * @throws 選單點不到，或期限內等不到有狀態欄的表格時
 */
async function openDeviceList(context, page) {
  const { menuText, pageTimeoutMs, statusColumns } = UNLOCK.deviceReset;
  log.step(`切換到「${menuText}」，檢查有沒有卡在「持續取得資料」的裝置`);
  await gotoMenuItem(page, menuText);
  const scan = await waitForDeviceTable(page);
  if (!scan) {
    await captureSnapshot(context, '裝置管理-找不到狀態欄');
    throw new Error(
      `點了選單「${menuText}」，但 ${pageTimeoutMs / 1000} 秒內畫面上都找不到`
        + `「${statusColumns[0]}」欄的表格，可能是版面改了、載入太慢或掉線了`,
    );
  }
  return scan;
}

/**
 * 按下某一列的鎖定或啟用，等整頁重送完，再把同一列讀回來。
 *
 * @returns {Promise<{clicked: boolean, reason?: string, after: StatusRow|null}>}
 *   `after`＝按完之後同一列的樣子（找不回那一列時為 null）
 */
async function pressRowButton(page, row, buttonKey, expectedStatus) {
  // 系統很可能跳確認視窗。Playwright 預設會自動按取消，不接手的話等於沒按（比照線上使用狀況）。
  const onDialog = async (dialog) => {
    log.info(`系統跳出確認視窗：「${dialog.message().slice(0, 60)}」→ 按下確定`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    const result = await clickStatusRowButton(content(page), {
      ...statusRowQuery(),
      fingerprint: row.fingerprint,
      expectedStatus,
      buttonKey,
    }).catch(() => ({ clicked: false, reason: 'noTable' }));
    if (!result.clicked) return { clicked: false, reason: result.reason, after: null };
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(UNLOCK.deviceReset.afterClickSettleMs);
  } finally {
    page.off('dialog', onDialog);
  }
  return { clicked: true, after: await readRowAfterClick(page, row.fingerprint, expectedStatus) };
}

/**
 * 按完之後把同一列讀回來，**等到它的狀態離開按之前的狀態**為止（或逾時）。
 *
 * 不能只讀一次：整頁重送還沒開始時讀到的是舊畫面，會誤判成「沒生效」——
 * 鎖定其實稍後生效了，裝置停在管理者停用，程式卻沒有警告。
 *
 * @returns {Promise<StatusRow|null>} 最後一次讀到的那一列；找不回來為 null
 */
async function readRowAfterClick(page, fingerprint, statusBefore) {
  const deadline = Date.now() + UNLOCK.deviceReset.pageTimeoutMs;
  let after = null;
  do {
    const scan = await waitForDeviceTable(page);
    after = scan?.rows.find((item) => item.fingerprint === fingerprint) ?? null;
    if (after && !statusMatches(after.status, statusBefore)) return after;
    await page.waitForTimeout(1000);
  } while (Date.now() < deadline);
  return after;
}

/**
 * 處理一台：鎖定 → 確認變成管理者停用 → 啟用 → 確認不再是管理者停用。
 *
 * @param {string} progress 例如「[3/133]」，讓長時間執行時看得出做到哪
 * @returns {Promise<{outcome: DeviceResetOutcome, abort: boolean}>}
 *   `abort`＝畫面上找不到清單了（多半是掉線），這一輪不該再往下做
 */
async function resetOneDevice(context, page, row, progress) {
  const { statusValues } = UNLOCK.deviceReset;
  const name = `${progress} ${describeDevice(row)}`;
  const done = (status, detail, leftDisabled = false, abort = false) =>
    ({ outcome: makeOutcome(row, status, detail, leftDisabled), abort });

  const locked = await pressRowButton(page, row, 'lock', statusValues.stuck);
  if (!locked.clicked) {
    if (locked.reason === 'statusChanged') {
      log.info(`${name}：已經不是「${statusValues.stuck[0]}」了，略過`);
      return done('無需處理', '輪到它時已經不是持續取得資料（自己恢復或有人處理過）');
    }
    const refusal = describeDeviceClickRefusal(locked.reason);
    log.warn(`${name}：沒有鎖定——${refusal}`);
    return done('需人工處理', `沒有鎖定：${refusal}`, false, locked.reason === 'noTable');
  }
  if (!locked.after) {
    await captureSnapshot(context, '裝置管理-鎖定後找不回那一列');
    log.warn(`${name}：已按下鎖定，但重整後找不回那一列`);
    return done('需人工處理', '已按下鎖定，但重整後找不回那一列，'
      + '這台可能停在管理者停用，請到系統設定 → 裝置管理手動按啟用', true, true);
  }
  if (!statusMatches(locked.after.status, statusValues.disabled)) {
    // 等滿時間仍是「持續取得資料」＝鎖定沒生效，裝置沒被動到；變成別的狀態則無從判斷，當成可能停用。
    log.warn(`${name}：按下鎖定後狀態是「${locked.after.status}」，沒有接著啟用`);
    return done('需人工處理', `已按下鎖定，但狀態是「${locked.after.status}」`
      + `而不是「${statusValues.disabled[0]}」，沒有接著啟用，請到系統確認`,
    !statusMatches(locked.after.status, statusValues.stuck));
  }

  const enabled = await pressRowButton(page, locked.after, 'enable', statusValues.disabled);
  if (!enabled.clicked) {
    const refusal = describeDeviceClickRefusal(enabled.reason);
    log.warn(`${name}：已鎖定但沒有啟用——${refusal}`);
    return done('需人工處理', `已鎖定但沒有啟用：${refusal}。`
      + '這台停在管理者停用，請到系統設定 → 裝置管理手動按啟用', true, enabled.reason === 'noTable');
  }
  if (!enabled.after || statusMatches(enabled.after.status, statusValues.disabled)) {
    await captureSnapshot(context, '裝置管理-啟用後仍是停用');
    log.warn(`${name}：已按下啟用，但無法確認它不再是管理者停用`);
    return done('需人工處理', '已按下啟用，但重整後無法確認它不再是管理者停用，'
      + '請到系統設定 → 裝置管理確認這台', true, !enabled.after);
  }
  const statusNow = enabled.after.status || '空白';
  log.ok(`${name}：已重置（目前狀態「${statusNow}」）`);
  return done('已重置', `鎖定後再啟用，目前狀態「${statusNow}」`);
}

/** 把一輪的結果印成摘要：成功的逐台已經印過，這裡只列要人處理的，最後再警告停用中的。 */
function printDeviceSummary(summary, dryRun) {
  const { outcomes } = summary;
  if (summary.stuckCount === 0) {
    log.ok(`裝置管理：清單 ${summary.scanned} 列，沒有卡在「持續取得資料」的裝置`);
    return;
  }
  for (const item of outcomes.filter((outcome) => outcome.status === '需人工處理')) {
    log.warn(`　${describeDevice(item)}：${item.detail}`);
  }
  const count = (status) => outcomes.filter((item) => item.status === status).length;
  const parts = dryRun
    ? [`會重置 ${count('會重置')} 台`]
    : [`已重置 ${count('已重置')} 台`, `已不需處理 ${count('無需處理')} 台`];
  parts.push(`需人工處理 ${count('需人工處理')} 台`);
  log.info(`裝置管理：清單 ${summary.scanned} 列，卡住 ${summary.stuckCount} 台｜${parts.join('｜')}`);
  if (summary.stoppedReason) log.warn(`裝置管理：沒有做完——${summary.stoppedReason}`);
  const leftDisabled = outcomes.filter((item) => item.leftDisabled);
  if (leftDisabled.length > 0) {
    log.warn(`⚠ 有 ${leftDisabled.length} 台可能停在「管理者停用」，分隊會不能用，請立刻到系統設定 → 裝置管理手動按啟用！`);
  }
}

/**
 * 每做完一台之後：讓監看穿插處理解鎖申請；它把畫面帶走的話重新打開裝置管理。
 *
 * 穿插處理本身出錯不該中斷重置，只記下來。
 *
 * @returns {Promise<boolean>} 能不能繼續做下一台（重新打開裝置管理失敗時為 false）
 */
async function runBetweenDevices(context, page, betweenDevices) {
  let leftPage = false;
  try {
    leftPage = await betweenDevices();
  } catch (error) {
    log.warn(`重置裝置途中處理解鎖申請出錯（繼續重置）：${error instanceof Error ? error.message : String(error)}`);
    leftPage = true; // 不知道畫面停在哪，當成被帶走
  }
  if (!leftPage) return true;
  try {
    await openDeviceList(context, page);
    return true;
  } catch (error) {
    log.warn(`處理完解鎖申請後回不到裝置管理：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 重置所有卡住的裝置（主入口，打不開清單會拋錯；常駐流程請用 {@link resetStuckDevicesSafely}）。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 * @param {DeviceResetOptions} options
 * @returns {Promise<DeviceResetSummary>}
 */
export async function resetStuckDevices(context, page, options) {
  const scan = await openDeviceList(context, page);
  const { targets, skipped } = pickStuckDevices(scan, UNLOCK.deviceReset.statusValues);
  /** @type {DeviceResetOutcome[]} */
  const outcomes = skipped.map(({ row, why }) => makeOutcome(row, '需人工處理', `沒有動手：${why}`));
  const summary = { scanned: scan.scanned, stuckCount: targets.length + skipped.length, outcomes, stoppedReason: null };
  if (targets.length === 0) return summary;

  if (options.dryRun) {
    for (const row of targets) {
      log.info(`　${describeDevice(row)}：狀態「${row.status}」，會先鎖定再啟用`);
      outcomes.push(makeOutcome(row, '會重置', '試跑：會先鎖定再啟用'));
    }
    log.info(`正式執行時約需 ${estimateMinutes(targets.length)} 分鐘`);
    return summary;
  }

  log.info(`有 ${targets.length} 台要重置，預估約 ${estimateMinutes(targets.length)} 分鐘；`
    + `${options.betweenDevices ? '每做完一台會先看有沒有新的解鎖申請' : '做完才會繼續其他工作'}。`);
  for (const [position, row] of targets.entries()) {
    const remaining = targets.length - position;
    if (options.shouldStop?.()) {
      summary.stoppedReason = `收到結束指示，還有 ${remaining} 台沒做，下次登入會接著做`;
      break;
    }
    if (position > 0 && options.betweenDevices && !(await runBetweenDevices(context, page, options.betweenDevices))) {
      summary.stoppedReason = `回不到裝置管理，還有 ${remaining} 台沒做，下次登入會接著做`;
      break;
    }
    const { outcome, abort } = await resetOneDevice(context, page, row, `[${position + 1}/${targets.length}]`);
    outcomes.push(outcome);
    if (abort) {
      summary.stoppedReason = `畫面上找不到裝置清單（多半是掉線了），還有 ${remaining - 1} 台沒做，下次登入會接著做`;
      break;
    }
  }
  return summary;
}

/**
 * 給「剛登入後」呼叫的版本：**絕不拋錯**，出事只記下來。
 *
 * 裝置重置是附帶的保養動作，它失敗不該拖垮後面的解鎖工單，
 * 更不該讓常駐監看整個結束。
 *
 * @param {{context: import('playwright-core').BrowserContext, page: import('playwright-core').Page}} session
 * @param {DeviceResetOptions} options
 * @returns {Promise<DeviceResetSummary|null>} 打不開清單時回傳 null
 */
export async function resetStuckDevicesSafely(session, options) {
  try {
    const summary = await resetStuckDevices(session.context, session.page, options);
    printDeviceSummary(summary, options.dryRun);
    return summary;
  } catch (error) {
    log.warn(`裝置管理重置沒有完成（不影響解鎖工單）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
