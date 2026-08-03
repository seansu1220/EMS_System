/**
 * 表單填寫共用邏輯（統計流程與解鎖流程共用）。
 *
 * 這套系統的欄位有兩個特性必須特別處理：
 *   1. 日期欄是 My97DatePicker，設成 readonly 強迫從日曆點選，`fill()` 會直接失敗。
 *   2. 條件沒真的填進去卻照樣查詢，系統會回傳「全部資料」——曾因此撈到上萬筆。
 * 因此一律「填完回讀驗證」，對不上就中止。
 */
import { log } from './logger.mjs';

/**
 * 在指定 frame 填入一個欄位的值，並回讀確認。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string} selector
 * @param {string} value
 * @param {string} label 供訊息顯示的欄位名稱
 * @param {{displayValue?: string}} [options] 值屬個人資料時，傳入遮蔽後的字串；
 *   **給了這個參數就代表「真值不可出現在畫面與紀錄檔」**，連錯誤訊息也不會印出原值
 * @returns {Promise<void>}
 */
export async function fillField(frame, selector, value, label, options = {}) {
  const field = frame.locator(selector);
  const isReadonly = await field
    .evaluate((element) => element.hasAttribute('readonly') || element.readOnly === true)
    .catch(() => false);
  // 欄位在收合的進階搜尋區塊裡時是看不見的，此時 fill() 只會白等 10 秒才失敗，
  // 直接走下面的「寫入 value」路徑即可，結果一樣且不浪費時間。
  const isVisible = await field.isVisible().catch(() => false);

  if (!isVisible) {
    log.info(`${label} 目前不可見（可能在收合的搜尋區塊內），直接寫入值`);
  } else if (isReadonly) {
    log.info(`${label} 為唯讀欄位（只能用日曆點選），直接寫入值`);
  } else {
    try {
      await frame.fill(selector, value, { timeout: 10000 });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      log.warn(`${label} 無法直接輸入（${reason}），改用直接寫入`);
    }
  }

  await frame.evaluate(
    ({ fieldSelector, fieldValue }) => {
      const element = document.querySelector(fieldSelector);
      if (!element) return;
      element.removeAttribute('readonly');
      element.value = fieldValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { fieldSelector: selector, fieldValue: value },
  );

  const shownValue = options.displayValue ?? value;
  const actual = await field.inputValue().catch(() => null);
  if (actual !== value) {
    // 敏感欄位連「實際讀到什麼」都不能印，只說長度，足夠判斷是「沒填進去」還是「填錯」。
    const shownActual = options.displayValue
      ? `${String(actual ?? '').length} 個字元`
      : `「${actual}」`;
    throw new Error(`${label} 填入後回讀不符：預期「${shownValue}」，實際 ${shownActual}`);
  }
  log.info(`${label}＝${shownValue}（已確認）`);
}

/**
 * 讀取日期欄位的 My97DatePicker 設定，取得系統採用的日期格式。
 *
 * 格式藏在欄位的 onfocus／onclick 屬性裡（`WdatePicker({dateFmt:'yyyy-MM-dd HH:mm:ss'})`）。
 * 少了時分秒的處理，`HH:mm:ss` 會原樣留在字串裡而讓查詢條件失效（曾撈到全部資料）。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string} selector 日期欄位
 * @param {string} fallback 偵測不到時採用的格式
 * @returns {Promise<string>}
 */
export async function detectDateFormat(frame, selector, fallback) {
  const attributeText = await frame
    .locator(selector)
    .evaluate((element) =>
      ['onfocus', 'onclick', 'onchange'].map((name) => element.getAttribute(name) || '').join(' '),
    )
    .catch(() => '');
  const matched = /dateFmt\s*:\s*'([^']+)'/.exec(attributeText);
  if (matched) {
    log.info(`日期格式：${matched[1]}（自系統日期元件偵測）`);
    return matched[1];
  }
  log.warn(`偵測不到系統日期格式，改用預設值 ${fallback}`);
  return fallback;
}

/**
 * 勾選／取消勾選一個勾選框，並回讀確認。
 *
 * 為什麼不直接用 Playwright 的 `check()`：目標欄位常在收合的進階搜尋區塊裡，
 * 元素不可見時 `check()` 會等 10 秒才失敗。這裡沿用 `fillField` 的作法——
 * 可見就正常點，不可見就直接改 `checked` 並補送 change 事件（系統的 onchange 才會跑到）。
 *
 * **一定要回讀**：條件沒真的設定進去而照樣查詢時，這個系統會回傳全部資料，
 * 統計結果會錯得很難察覺（第 1 章曾因此撈到上萬筆）。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string} selector
 * @param {boolean} checked 要不要勾起來
 * @param {string} label 供訊息顯示的欄位名稱
 * @returns {Promise<void>}
 */
export async function setCheckbox(frame, selector, checked, label) {
  const field = frame.locator(selector);
  const isVisible = await field.isVisible().catch(() => false);

  if (isVisible) {
    try {
      await field.setChecked(checked, { timeout: 10000 });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      log.warn(`${label} 無法直接點選（${reason}），改用直接寫入`);
    }
  } else {
    log.info(`${label} 目前不可見（可能在收合的搜尋區塊內），直接寫入值`);
  }

  await frame.evaluate(
    ({ fieldSelector, fieldChecked }) => {
      const element = document.querySelector(fieldSelector);
      if (!element || element.checked === fieldChecked) return;
      element.checked = fieldChecked;
      element.dispatchEvent(new Event('click', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { fieldSelector: selector, fieldChecked: checked },
  );

  // 回讀給短一點的時間上限：欄位存在時是瞬間就有答案，
  // 用 Playwright 的預設值（30 秒）只會在「選擇器根本找不到元素」時白等半分鐘。
  const actual = await field.isChecked({ timeout: 5000 }).catch(() => null);
  if (actual !== checked) {
    throw new Error(
      `${label} 設定後回讀不符：預期「${checked ? '已勾選' : '未勾選'}」，`
        + `實際「${actual === null ? '讀不到' : actual ? '已勾選' : '未勾選'}」`,
    );
  }
  log.info(`${label}＝${checked ? '已勾選' : '未勾選'}（已確認）`);
}

/**
 * 在指定 frame 選取下拉選項（以 value 指定，避免文字有全半形差異），並回讀確認。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string} selector
 * @param {string} value
 * @param {string} label
 * @returns {Promise<void>}
 */
export async function selectField(frame, selector, value, label) {
  try {
    await frame.selectOption(selector, value, { timeout: 10000 });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    log.warn(`${label} 無法直接選取（${reason}），改用直接寫入`);
    await frame.evaluate(
      ({ fieldSelector, fieldValue }) => {
        const element = document.querySelector(fieldSelector);
        if (!element) return;
        element.value = fieldValue;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { fieldSelector: selector, fieldValue: value },
    );
  }

  const actual = await frame.locator(selector).inputValue().catch(() => null);
  if (actual !== value) {
    throw new Error(`${label} 選取後回讀不符：預期「${value}」，實際「${actual}」`);
  }
  log.info(`${label}（已確認）`);
}
