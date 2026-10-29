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
 * 一次性的線上解鎖工單登入後。另有 `device-reset` 指令可單獨跑（預設試跑）。
 *
 * ## 最怕的不是按錯，是「鎖了沒啟用」
 * 鎖定之後若沒能啟用，那台裝置就停在管理者停用、分隊完全不能用。所以：
 * - 一次只處理一台，**鎖定與啟用緊接著做**，不是全部鎖完再全部啟用
 * - 啟用沒成功一律大聲回報「這台停在管理者停用，請手動按啟用」
 * - 一輪冒出太多台卡住（`maxDevicesPerRun`）時判定為讀錯，一台都不動
 *
 * ## 是哪一列：靠「整列不會變的文字」
 * 這一頁尚未探測，沒有確定唯一的編號欄，因此以「整列扣掉狀態欄、時間類欄位、按鈕格」
 * 的文字辨識（見 `pageFinder.mjs` 的 `statusRows` 模式）。這段文字可能含帳號，
 * 只在頁面裡算成短碼帶出來，原文不離開瀏覽器。短碼在整張表不唯一的列一律不動。
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
 * @property {string|null} label 車輛／單位（讀不到為 null）
 * @property {'已重置'|'會重置'|'需人工處理'} status
 *   `會重置`＝試跑模式下找到了這一台，沒有動手
 * @property {string} detail 給人看的說明
 * @property {boolean} leftDisabled 這台是否**可能停在管理者停用**（鎖了但沒確認啟用），需要人立刻處理
 */

/**
 * @typedef {Object} DeviceResetSummary 一輪重置的總結
 * @property {number} scanned 清單掃了幾列
 * @property {DeviceResetOutcome[]} outcomes 每台卡住裝置的結果（沒有卡住的為空陣列）
 * @property {string|null} blockedReason 整輪沒有動手的理由（例如卡住的台數多得不正常）
 */

/** 組出頁面端查詢要用的欄位設定（全部來自 `UNLOCK.deviceReset`）。 */
function statusRowQuery() {
  const { statusColumns, labelColumns, volatileHeaderKeywords, buttonTexts, maxRows } = UNLOCK.deviceReset;
  return { statusColumns, labelColumns, volatileHeaderKeywords, buttonTexts, maxRows };
}

/** 狀態文字是否屬於某一組（忽略空白，以「包含」比對）。 */
export function statusMatches(status, candidates) {
  const compact = String(status ?? '').replace(/[\s　]+/g, '');
  return candidates.some((candidate) => compact.includes(candidate.replace(/[\s　]+/g, '')));
}

/** 「第 N 列（桃園91）」：畫面與紀錄檔上指稱某一台的寫法。 */
export function describeDevice(row) {
  return `第 ${row.rowIndex} 列（${row.label ?? '讀不到車輛／單位'}）`;
}

/**
 * 從掃描結果挑出這一輪要處理的裝置（純函式，不碰瀏覽器，方便測試）。
 *
 * @param {{rows: StatusRow[]}} scan
 * @param {{stuck: string[]}} statusValues
 * @param {number} maxDevices 一輪最多處理幾台，超過就整輪不動
 * @returns {{targets: StatusRow[], skipped: {row: StatusRow, why: string}[], blockedReason: string|null}}
 */
export function pickStuckDevices(scan, statusValues, maxDevices) {
  const stuck = scan.rows.filter((row) => statusMatches(row.status, statusValues.stuck));
  if (stuck.length > maxDevices) {
    return {
      targets: [],
      skipped: [],
      blockedReason: `有 ${stuck.length} 台都是卡住的狀態，超過一輪上限 ${maxDevices} 台，`
        + '多半是畫面判讀錯了，這一輪一台都不動，請到系統設定 → 裝置管理看一眼',
    };
  }
  const targets = [];
  const skipped = [];
  for (const row of stuck) {
    if (!row.unique) {
      // 認不出唯一的一列，就沒辦法在鎖定之後找回它去按啟用——寧可不鎖。
      skipped.push({ row, why: '清單裡有別列跟它長得一樣（或整列讀不到內容），無法確定按的是同一台' });
    } else if (!row.buttons.lock) {
      skipped.push({ row, why: '那一列裡找不到「鎖定」按鈕' });
    } else {
      targets.push(row);
    }
  }
  return { targets, skipped, blockedReason: null };
}

/**
 * 把 `clickStatusRowButton` 沒動手的理由翻成人話。
 * @param {string|undefined} reason
 */
export function describeDeviceClickRefusal(reason) {
  if (reason === 'noTable') return '畫面上找不到裝置清單（可能被導走了）';
  if (reason === 'notFound') return '要按的時候那一列已經不在了（可能畫面重整過或欄位內容變了）';
  if (reason === 'notUnique') return '要按的時候變成多列相符，為安全起見沒有動手';
  if (reason === 'statusChanged') return '要按的時候那一列的狀態已經不是預期的了';
  if (reason === 'noButton') return '要按的時候那一列裡找不到按鈕';
  return `沒有動手（${reason ?? '原因不明'}）`;
}

/**
 * 等清單真的出現（找得到狀態欄的表格才算載完）。
 * @returns {Promise<Awaited<ReturnType<typeof findStatusRows>>|null>} 逾時回傳 null
 */
async function waitForDeviceTable(page) {
  const deadline = Date.now() + UNLOCK.deviceReset.pageTimeoutMs;
  let lastScan = null;
  while (Date.now() < deadline) {
    lastScan = await findStatusRows(content(page), statusRowQuery()).catch(() => null);
    if (lastScan?.found) return lastScan;
    await page.waitForTimeout(500);
  }
  return lastScan?.found ? lastScan : null;
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
        + `「${statusColumns[0]}」欄的表格，可能是版面改了或載入太慢`,
    );
  }
  return scan;
}

/**
 * 按下某一列的鎖定或啟用，等整頁重送完，再把清單讀回來。
 *
 * @returns {Promise<{clicked: boolean, refusal?: string, after: StatusRow|null}>}
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
    });
    if (!result.clicked) {
      return { clicked: false, refusal: describeDeviceClickRefusal(result.reason), after: null };
    }
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
 * @returns {Promise<DeviceResetOutcome>}
 */
async function resetOneDevice(context, page, row) {
  const { statusValues, buttonTexts } = UNLOCK.deviceReset;
  const name = describeDevice(row);
  const outcome = (status, detail, leftDisabled = false) =>
    ({ rowIndex: row.rowIndex, label: row.label, status, detail, leftDisabled });

  log.step(`${name}：按下「${buttonTexts.lock[0]}」`);
  const locked = await pressRowButton(page, row, 'lock', statusValues.stuck);
  if (!locked.clicked) return outcome('需人工處理', `沒有鎖定：${locked.refusal}`);
  if (!locked.after) {
    await captureSnapshot(context, '裝置管理-鎖定後找不回那一列');
    return outcome('需人工處理', '已按下鎖定，但重整後找不回那一列，'
      + '這台可能停在管理者停用，請到系統設定 → 裝置管理手動按啟用', true);
  }
  if (!statusMatches(locked.after.status, statusValues.disabled)) {
    // 等滿時間仍是「持續取得資料」＝鎖定沒生效，裝置沒被動到；變成別的狀態則無從判斷，當成可能停用。
    return outcome('需人工處理', `已按下鎖定，但狀態是「${locked.after.status}」`
      + `而不是「${statusValues.disabled[0]}」，沒有接著啟用，請到系統確認`,
    !statusMatches(locked.after.status, statusValues.stuck));
  }

  log.step(`${name}：狀態已是「${locked.after.status}」，按下「${buttonTexts.enable[0]}」`);
  const enabled = await pressRowButton(page, locked.after, 'enable', statusValues.disabled);
  if (!enabled.clicked) {
    return outcome('需人工處理', `已鎖定但沒有啟用：${enabled.refusal}。`
      + '這台停在管理者停用，請到系統設定 → 裝置管理手動按啟用', true);
  }
  if (!enabled.after || statusMatches(enabled.after.status, statusValues.disabled)) {
    await captureSnapshot(context, '裝置管理-啟用後仍是停用');
    return outcome('需人工處理', '已按下啟用，但重整後無法確認它不再是管理者停用，'
      + '請到系統設定 → 裝置管理確認這台', true);
  }
  log.ok(`${name}：已重置（目前狀態「${enabled.after.status || '空白'}」）`);
  return outcome('已重置', `鎖定後再啟用，目前狀態「${enabled.after.status || '空白'}」`);
}

/** 把一輪的結果印成摘要；有停在管理者停用的裝置時特別警告。 */
function printDeviceSummary(summary, dryRun) {
  const { outcomes } = summary;
  if (summary.blockedReason) {
    log.warn(`裝置管理：${summary.blockedReason}`);
    return;
  }
  if (outcomes.length === 0) {
    log.ok(`裝置管理：清單 ${summary.scanned} 列，沒有卡在「持續取得資料」的裝置`);
    return;
  }
  for (const item of outcomes) {
    const line = `　第 ${item.rowIndex} 列（${item.label ?? '讀不到車輛／單位'}）：${item.status}｜${item.detail}`;
    if (item.status === '需人工處理') log.warn(line);
    else log.info(line);
  }
  const done = outcomes.filter((item) => item.status === (dryRun ? '會重置' : '已重置')).length;
  log.info(`裝置管理：卡住 ${outcomes.length} 台，${dryRun ? '試跑會重置' : '已重置'} ${done} 台`);
  const leftDisabled = outcomes.filter((item) => item.leftDisabled);
  if (leftDisabled.length > 0) {
    log.warn(`⚠ 有 ${leftDisabled.length} 台可能停在「管理者停用」，分隊會不能用，請立刻到系統設定 → 裝置管理手動按啟用！`);
  }
}

/**
 * 重置所有卡住的裝置（主入口，失敗會拋錯；常駐流程請用 {@link resetStuckDevicesSafely}）。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 * @param {{dryRun: boolean}} options `dryRun`＝true 時只回報會處理哪幾台，**不動手**
 * @returns {Promise<DeviceResetSummary>}
 */
export async function resetStuckDevices(context, page, options) {
  const { statusValues, maxDevicesPerRun } = UNLOCK.deviceReset;
  const scan = await openDeviceList(context, page);
  const picked = pickStuckDevices(scan, statusValues, maxDevicesPerRun);
  if (picked.blockedReason) {
    await captureSnapshot(context, '裝置管理-卡住台數異常');
    return { scanned: scan.scanned, outcomes: [], blockedReason: picked.blockedReason };
  }

  /** @type {DeviceResetOutcome[]} */
  const outcomes = picked.skipped.map(({ row, why }) =>
    ({ rowIndex: row.rowIndex, label: row.label, status: '需人工處理', detail: `沒有動手：${why}`, leftDisabled: false }));
  for (const row of picked.targets) {
    if (options.dryRun) {
      log.ok(`${describeDevice(row)}：狀態「${row.status}」，會先鎖定再啟用`);
      outcomes.push({ rowIndex: row.rowIndex, label: row.label, status: '會重置',
        detail: '試跑：會先鎖定再啟用', leftDisabled: false });
      continue;
    }
    outcomes.push(await resetOneDevice(context, page, row));
  }
  return { scanned: scan.scanned, outcomes, blockedReason: null };
}

/**
 * 給「剛登入後」呼叫的版本：**絕不拋錯**，出事只記下來。
 *
 * 裝置重置是附帶的保養動作，它失敗不該拖垮後面的解鎖工單，
 * 更不該讓常駐監看整個結束。
 *
 * @param {{context: import('playwright-core').BrowserContext, page: import('playwright-core').Page}} session
 * @param {{dryRun: boolean}} options
 * @returns {Promise<DeviceResetSummary|null>} 整輪出錯時回傳 null
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
