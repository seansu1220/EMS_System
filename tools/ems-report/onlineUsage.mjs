/**
 * 第二種解鎖路徑：刪除「線上使用狀況」裡的佔用紀錄。
 *
 * ## 什麼時候用得到
 * 案件內部的紀錄表**本來就沒有鎖頭**（已是未結案），分隊卻還是進不去改。
 * 這種卡住不是結案鎖造成的，而是那份紀錄表**被某台裝置佔用著**——
 * 系統在「系統設定 → 線上使用狀況」記著誰正在線上使用，把那一筆刪掉才放得開
 * （使用者 2026-09-11 指定）。
 *
 * 因此 `unlock.mjs` 的主流程判到「沒鎖頭」時會自動接來這裡，
 * 而不是像以前那樣直接回報「無需處理」就結束——那句話在這種情況下是錯的。
 *
 * ## 為什麼定位方式跟別處不一樣
 * 這一頁**沒有查詢欄**，就是一張列出全部佔用紀錄的表；而且每一列尾端那顆刪除鈕
 * **id 全部都是 `_btnDelete`**（2026-09-11 探測確認），序號與 id 都不能當定位依據。
 * 唯一靠得住的是「同一個 `<tr>`」。
 *
 * ## 刪錯一列的後果不可復原，所以閘門有四道
 * 1. TEMSIS 欄**完全相等**才算命中（不是包含）
 * 2. 相符的列**剛好一列**才動手；0 列或 2 列以上一律不動手
 * 3. 只取**那一列裡面的**刪除鈕，而且該鈕的 `onclick` 要自己寫著這組 TEMSIS
 *    （這一頁的按鈕自帶該列資料，等於按鈕自證身分）
 * 4. 前三項的判斷與「按下去」在**同一次頁面執行內**完成，中間沒有空隙讓畫面重排
 *
 * 再加上整個解鎖工具共用的 `--execute`：試跑只報「會刪哪一列」，不動手。
 *
 * ## 個資
 * 這張表另有「使用者」「裝置ID」「案件編號」等欄位，一律**不讀、不帶出、不記錄**。
 * 只取救護車與日期兩欄（行政資訊，與現有解鎖流程記的欄位同一類），
 * 供事後回頭核對「解除了哪一台車、什麼時候被佔用的」。編號一律只顯示末 4 碼。
 */
import { content } from './caseFlow.mjs';
import { UNLOCK } from './config.mjs';
import { log } from './logger.mjs';
import { gotoMenuItem } from './navigation.mjs';
import { clickRowButtonByColumnValue, findRowsByColumnValue } from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import { maskCode } from './sheetFields.mjs';

/** 這一頁要讀回來的欄位（其餘儲存格一律不外流）。 */
function wantedHeaders() {
  return [UNLOCK.onlineUsage.columns.vehicle[0], UNLOCK.onlineUsage.columns.occupiedAt[0]];
}

/** 把一列的欄位值整理成 `{vehicle, occupiedAt}`。 */
function readRowValues(values) {
  const { columns } = UNLOCK.onlineUsage;
  return {
    vehicle: values?.[columns.vehicle[0]] || null,
    occupiedAt: values?.[columns.occupiedAt[0]] || null,
  };
}

/**
 * 等畫面真的變成「線上使用狀況」這一頁。
 *
 * 以畫面出現特徵字為準而不是等固定秒數：太早往下做會在頁面還沒載完時
 * 回報「清單裡查無這筆」，而那是假的（比照 `waitForCaseDetail` 的作法）。
 *
 * @returns {Promise<boolean>}
 */
export async function waitForOnlineUsagePage(page) {
  const { pageMarkers, pageTimeoutMs } = UNLOCK.onlineUsage;
  const deadline = Date.now() + pageTimeoutMs;
  while (Date.now() < deadline) {
    const arrived = await content(page)
      .evaluate(
        (markers) => {
          const text = document.body?.innerText ?? '';
          return markers.some((marker) => text.includes(marker));
        },
        pageMarkers,
      )
      .catch(() => false);
    if (arrived) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * 導向「系統設定 → 線上使用狀況」。
 *
 * @throws 選單點不到，或頁面在期限內沒出現特徵字時
 */
export async function gotoOnlineUsage(page) {
  const { menuText, pageMarkers, pageTimeoutMs } = UNLOCK.onlineUsage;
  log.step(`切換到「${menuText}」`);
  await gotoMenuItem(page, menuText);
  if (!(await waitForOnlineUsagePage(page))) {
    throw new Error(
      `點了選單「${menuText}」，但畫面在 ${pageTimeoutMs / 1000} 秒內`
        + `沒有出現這一頁的特徵字（${pageMarkers.join('、')}），`
        + '可能是版面改了或載入太慢',
    );
  }
}

/**
 * 在清單中找出 TEMSIS 相符的那幾列（唯讀，不動任何東西）。
 *
 * @param {string} temsis
 * @returns {Promise<{found: boolean, reason?: string, headers: string[],
 *   tableHeaders?: string[], matches: import('./pageFinder.mjs').RowMatch[], scanned: number}>}
 */
export async function findUsageRows(page, temsis) {
  const { columns, deleteButtonTexts, maxRows } = UNLOCK.onlineUsage;
  return findRowsByColumnValue(content(page), {
    value: temsis,
    columnCandidates: columns.temsis,
    buttonTexts: deleteButtonTexts,
    wantedHeaders: wantedHeaders(),
    maxRows,
  });
}

/**
 * 把「這次掃描的結果」講成人話，寫進紀錄檔。
 *
 * 這是使用者事後判斷「程式到底看到了什麼」的唯一依據，因此連掃了幾列都要講。
 */
function describeScan(temsis, scan) {
  const where = `線上使用狀況清單掃了 ${scan.scanned} 列`;
  if (scan.matches.length === 0) return `${where}，沒有 TEMSIS ${maskCode(temsis)} 的佔用紀錄`;
  const rows = scan.matches
    .map((item) => {
      const { vehicle, occupiedAt } = readRowValues(item.values);
      return `第 ${item.rowIndex} 列（${vehicle ?? '車輛讀不到'}／${occupiedAt ?? '日期讀不到'}）`;
    })
    .join('、');
  return `${where}，相符 ${scan.matches.length} 列：${rows}`;
}

/**
 * 決定「掃描結果該怎麼辦」（純函式，不碰瀏覽器，方便測試）。
 *
 * 把判斷抽出來的理由：這是整條路徑最不能出錯的一段，而它其實只是一組規則，
 * 不該埋在一堆 `await` 中間、只能靠實跑才驗得到。
 *
 * @param {{found: boolean, reason?: string, matches: {hasButton: boolean,
 *   buttonSelfIdentifies: boolean}[], scanned: number}} scan
 * @returns {{action: 'delete'|'none'|'manual', why: string}}
 *   `action` 為 `delete` 才可以動手；`none` 代表這筆真的不用處理；
 *   `manual` 代表程式判斷不出來，必須交給人。
 */
export function decideUsageAction(scan) {
  if (!scan.found) {
    return { action: 'manual', why: '線上使用狀況這一頁找不到 TEMSIS 欄，版面可能改了' };
  }
  if (scan.matches.length === 0) {
    return { action: 'none', why: '清單裡沒有這筆的佔用紀錄' };
  }
  if (scan.matches.length > 1) {
    // 同一個 TEMSIS 出現兩列以上代表這頁的狀態本身就不尋常，任何選擇都是猜的。
    return {
      action: 'manual',
      why: `清單裡有 ${scan.matches.length} 列都是這個 TEMSIS，無法判斷該刪哪一列`,
    };
  }
  const [only] = scan.matches;
  if (!only.hasButton) {
    return { action: 'manual', why: '找到那一列了，但那一列裡面沒有刪除按鈕' };
  }
  if (!only.buttonSelfIdentifies) {
    // 按鈕的 onclick 沒寫著這組 TEMSIS：可能是系統換了傳值方式，也可能根本對到別列。
    // 分不出是哪一種時一律不動手——刪錯一列無法復原。
    return {
      action: 'manual',
      why: '那一列的刪除按鈕沒有自帶這組 TEMSIS，無法確認它屬於這一列',
    };
  }
  return { action: 'delete', why: '清單裡剛好一列相符，且該列的刪除按鈕自帶這組 TEMSIS' };
}

/**
 * 把 `clickRowButtonByColumnValue` 沒動手的理由翻成人話。
 *
 * 這幾種理由代表「按下去之前的那一瞬間，條件變得不成立了」——
 * 例如剛好有人同時刪掉、或畫面重整過。全部都不算失敗，但都要講清楚。
 */
export function describeClickRefusal(reason) {
  if (reason === 'notFound') return '要按的時候那一列已經不在了（可能剛好被別人刪掉，或畫面重整過）';
  if (reason === 'notUnique') return '要按的時候變成多列相符，為安全起見沒有動手';
  if (reason === 'noButton') return '要按的時候那一列裡找不到刪除按鈕';
  if (reason === 'buttonMismatch') return '要按的時候那顆按鈕已經不帶這組 TEMSIS 了';
  return `沒有動手（${reason ?? '原因不明'}）`;
}

/**
 * 按下刪除，並回讀確認那一列真的不見了。
 *
 * @returns {Promise<{confirmed: boolean, detail: string}>}
 */
async function deleteUsageRow(context, page, temsis) {
  const { columns, deleteButtonTexts, maxRows, afterDeleteSettleMs } = UNLOCK.onlineUsage;

  // 系統很可能跳確認視窗。**Playwright 預設會自動按取消**，
  // 不自己接手的話會靜靜地什麼都沒刪到，卻看起來像成功了（比照 `performUnlock`）。
  const onDialog = async (dialog) => {
    const message = dialog.message().replace(/\d{5,}/g, '#####').slice(0, 80);
    log.info(`系統跳出確認視窗：「${message}」→ 按下確定`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    const clickResult = await clickRowButtonByColumnValue(content(page), {
      value: temsis,
      columnCandidates: columns.temsis,
      buttonTexts: deleteButtonTexts,
      wantedHeaders: wantedHeaders(),
      maxRows,
    });
    if (!clickResult.clicked) {
      return { confirmed: false, detail: describeClickRefusal(clickResult.reason) };
    }
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(afterDeleteSettleMs);
  } finally {
    page.off('dialog', onDialog);
  }

  // 回讀驗證：這一頁按下刪除會整頁重送，重整後那一列應該就不見了。
  // 讀不到整張表（版面被導走）時**不算成功**——不知道不等於成功，
  // 這一點與解鎖流程的判定原則一致。
  if (!(await waitForOnlineUsagePage(page))) {
    await captureSnapshot(context, '線上使用狀況-刪除後畫面被導走');
    return {
      confirmed: false,
      detail: '已按下刪除，但畫面沒有回到線上使用狀況清單，無法確認是否生效，請自行到系統確認',
    };
  }
  const after = await findUsageRows(page, temsis);
  if (!after.found) {
    await captureSnapshot(context, '線上使用狀況-刪除後讀不到表格');
    return {
      confirmed: false,
      detail: '已按下刪除，但重整後讀不到清單表格，無法確認是否生效，請自行到系統確認',
    };
  }
  if (after.matches.length > 0) {
    return {
      confirmed: false,
      detail: `已按下刪除，但重整後那一列還在（仍有 ${after.matches.length} 列相符），`
        + '可能沒有生效，請自行到系統確認',
    };
  }
  return { confirmed: true, detail: '已按下刪除，重整後清單裡已經沒有這一筆' };
}

/**
 * 解除某個 TEMSIS 的線上使用佔用（第二種解鎖路徑的主入口）。
 *
 * 呼叫時機：主流程判定紀錄表**本來就沒有鎖頭**之後。此時畫面停在案件內部，
 * 本函式會自己切到線上使用狀況那一頁；下一筆 TEMSIS 的開頭會重新導回
 * 救護紀錄表查詢（見 `findDispatchNoByTemsis`），因此不需要在這裡收尾。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page
 * @param {string} temsis
 * @param {{dryRun: boolean}} options `dryRun`＝true 時只回報會刪哪一列，**不動手**
 * @returns {Promise<{status: '已解除佔用'|'已定位佔用'|'無需處理'|'需人工處理',
 *   detail: string, vehicle: string|null, occupiedAt: string|null}>}
 */
export async function clearOnlineUsage(context, page, temsis, options) {
  await gotoOnlineUsage(page);
  const scan = await findUsageRows(page, temsis);

  if (!scan.found) {
    await captureSnapshot(context, '線上使用狀況-找不到TEMSIS欄');
    const headers = (scan.tableHeaders ?? []).join(' ／ ') || '(讀不到表格)';
    return {
      status: '需人工處理',
      detail: `線上使用狀況這一頁找不到「${UNLOCK.onlineUsage.columns.temsis[0]}」欄`
        + `（可能改版了）。這一頁實際的欄位：${headers}`,
      vehicle: null,
      occupiedAt: null,
    };
  }

  log.info(describeScan(temsis, scan));
  const decision = decideUsageAction(scan);
  const row = scan.matches[0]
    ? readRowValues(scan.matches[0].values)
    : { vehicle: null, occupiedAt: null };

  if (decision.action === 'none') {
    return {
      status: '無需處理',
      detail: '線上使用狀況裡也沒有佔用紀錄，這筆不需要解鎖',
      vehicle: null,
      occupiedAt: null,
    };
  }
  if (decision.action === 'manual') {
    return {
      status: '需人工處理',
      detail: `改查線上使用狀況：${decision.why}。${describeScan(temsis, scan)}`,
      vehicle: row.vehicle,
      occupiedAt: row.occupiedAt,
    };
  }

  const target = `${row.vehicle ?? '車輛讀不到'}　${row.occupiedAt ?? '日期讀不到'}`;
  if (options.dryRun) {
    log.ok(`${maskCode(temsis)}：會刪掉線上使用狀況的第 ${scan.matches[0].rowIndex} 列（${target}）`);
    return {
      status: '已定位佔用',
      detail: `試跑：會刪掉線上使用狀況裡的這一列（${target}）；${decision.why}`,
      vehicle: row.vehicle,
      occupiedAt: row.occupiedAt,
    };
  }

  log.step(`按下線上使用狀況的「${deleteButtonLabel()}」（${target}）`);
  const result = await deleteUsageRow(context, page, temsis);
  if (result.confirmed) {
    log.ok(`已解除佔用：${target}　TEMSIS ${maskCode(temsis)}`);
    return {
      status: '已解除佔用',
      detail: `卡住的原因是被線上使用佔用著（${target}）；${result.detail}`,
      vehicle: row.vehicle,
      occupiedAt: row.occupiedAt,
    };
  }
  log.warn(`${maskCode(temsis)}：${result.detail}`);
  return {
    status: '需人工處理',
    detail: `改查線上使用狀況並找到了那一列（${target}），但${result.detail}`,
    vehicle: row.vehicle,
    occupiedAt: row.occupiedAt,
  };
}

/** 刪除鈕的顯示文字（只用於訊息，取設定的第一個候選）。 */
function deleteButtonLabel() {
  return UNLOCK.onlineUsage.deleteButtonTexts[0];
}
