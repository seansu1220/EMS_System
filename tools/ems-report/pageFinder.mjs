/**
 * 以「畫面上看得到的文字」定位欄位與按鈕。
 *
 * 為什麼不用 id：解鎖流程走的畫面（案件列表、案件內部、救護紀錄表）尚未探測過，
 * id 無從得知；而且這套系統改版時 id 會變、畫面文字不太會變。
 * 以文字定位等於用「人看畫面的方式」找元素，比 id 耐用。
 *
 * ⚠ 個資原則：本檔只回傳「元素的描述」（標籤文字、按鈕文字、序號），
 *   絕不回傳任何欄位值或資料列內容。按鈕文字會先遮蔽 5 碼以上數字再截斷。
 *
 * 實作說明：所有頁面端邏輯集中在 `queryPage` 一個函式裡。
 * Playwright 會把函式序列化送進瀏覽器執行，**函式內不能引用模組作用域的任何東西**，
 * 拆成多個函式就得把比對規則複製好幾份，改一處漏一處，因此刻意只留一份。
 */

/**
 * @typedef {Object} FieldMatch
 * @property {string} selector 可直接餵給 Playwright 的選擇器
 * @property {string} labelText 命中的標籤文字（供人核對找對了沒）
 * @property {boolean} visible 目前是否可見（不可見代表在收合的進階搜尋區塊裡）
 * @property {string} matchedBy 靠哪一種關聯找到的，排查時很有用
 */

/**
 * @typedef {Object} ClickableMatch
 * @property {number} index 在「所有符合的元素」中的序號（0 起算，document 順序）
 * @property {string} tag
 * @property {string} text 元素上看得到的文字（已遮蔽數字並截斷）
 * @property {boolean} visible
 * @property {number} rowIndex 所在表格列的序號（-1 代表不在表格內）
 */

/**
 * 文字正規化：去掉空白與常見標點並轉大寫。
 *
 * 舊系統的標籤常寫成「T E M S I S 編號：」「派遣案號 ：」這類形式，
 * 不正規化就會比對不到。此處與 `queryPage` 內的同名函式行為必須一致
 * （已由 pageFinder.test.mjs 釘住）。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\s　]+/g, '')
    .replace(/[：:＊*．.、,，]/g, '')
    .toUpperCase();
}

/**
 * 所有頁面端查詢的唯一入口，在瀏覽器裡執行。
 *
 * @param {Object} params
 * @param {'field'|'clickables'|'click'|'pairs'} params.mode
 */
function queryPage(params) {
  const normalize = (text) =>
    String(text ?? '')
      .replace(/[\s　]+/g, '')
      .replace(/[：:＊*．.、,，]/g, '')
      .toUpperCase();

  const isVisible = (element) =>
    Boolean(element.offsetParent) || element.getClientRects().length > 0;

  /** 遮蔽 5 碼以上連續數字，避免按鈕文字裡夾帶案件編號被記錄下來。 */
  const mask = (text) => String(text ?? '').replace(/\d{5,}/g, '#####');

  /** 元素上「人看得到」的文字：內容文字 ＋ alt/title/value（圖片按鈕只有這些）。 */
  const labelOf = (element) =>
    [
      element.getAttribute('alt'),
      element.getAttribute('title'),
      element.getAttribute('value'),
      // 只取沒有子元素的節點的文字，否則外層容器會把整頁文字都吃進來。
      element.children.length === 0 ? element.textContent : '',
    ]
      .filter(Boolean)
      .join(' ');

  /**
   * 收集所有文字符合的可點擊元素（document 順序，因此序號是穩定的）。
   * 每次都重新查詢：這套系統每個動作都會重載 frame，舊的元素參照會失效。
   */
  const collectClickables = (texts, exact, onlyVisible) => {
    const wanted = texts.map(normalize);
    const matched = [];
    for (const element of document.querySelectorAll('a, img, button, input, [onclick]')) {
      const type = (element.getAttribute('type') || '').toLowerCase();
      if (element.tagName === 'INPUT' && !['submit', 'button', 'image', 'reset'].includes(type)) {
        continue;
      }
      const text = normalize(labelOf(element));
      if (!text) continue;
      const hit = exact ? wanted.includes(text) : wanted.some((item) => text.includes(item));
      if (!hit) continue;
      if (onlyVisible && !isVisible(element)) continue;
      matched.push(element);
    }
    return matched;
  };

  /** 所有表格列，用來標示元素落在第幾列（判斷「幾筆案件」時要用）。 */
  const allRows = [...document.querySelectorAll('tr')];

  const describeClickable = (element, index) => {
    const row = element.closest('tr');
    return {
      index,
      tag: element.tagName.toLowerCase(),
      text: mask(labelOf(element)).replace(/\s+/g, ' ').trim().slice(0, 40),
      visible: isVisible(element),
      // 同一列的多個按鈕（例如「救護紀錄PDF」與「救護紀錄PDF(桃)」）屬於同一筆案件，
      // 有這個序號才不會把 2 個按鈕誤判成 2 筆案件。
      rowIndex: row ? allRows.indexOf(row) : -1,
    };
  };

  if (params.mode === 'clickables') {
    return collectClickables(params.texts, params.exact, params.onlyVisible).map(describeClickable);
  }

  if (params.mode === 'clickableTexts') {
    // 找不到目標按鈕時，回報「這一頁到底有哪些可以點的東西」，
    // 省下請使用者重跑一次探測的功夫。數字已遮蔽，且只取文字不取任何欄位值。
    const seen = new Set();
    for (const element of document.querySelectorAll('a, img, button, input, [onclick]')) {
      const type = (element.getAttribute('type') || '').toLowerCase();
      if (element.tagName === 'INPUT' && !['submit', 'button', 'image', 'reset'].includes(type)) {
        continue;
      }
      const text = mask(labelOf(element)).replace(/\s+/g, ' ').trim().slice(0, 20);
      if (text) seen.add(text);
      if (seen.size >= params.limit) break;
    }
    return [...seen];
  }

  if (params.mode === 'click') {
    const target = collectClickables(params.texts, params.exact, params.onlyVisible)[params.index];
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }

  if (params.mode === 'pairs') {
    // 把「紀錄連結」與「解鎖按鈕」以所在的表格列配對。
    // 純粹靠序號配對很危險（順序未必一致），同一列才能確定是同一張紀錄表。
    const records = collectClickables(params.recordTexts, params.recordExact, true);
    const unlocks = collectClickables(params.unlockTexts, params.unlockExact, true);
    const pairs = records.map((record, recordIndex) => {
      const row = record.closest('tr');
      const unlockIndex = row ? unlocks.findIndex((unlock) => row.contains(unlock)) : -1;
      return {
        recordIndex,
        unlockIndex,
        recordText: mask(labelOf(record)).replace(/\s+/g, ' ').trim().slice(0, 40),
      };
    });
    return {
      pairs,
      recordCount: records.length,
      unlockCount: unlocks.length,
      unlockTexts: unlocks.map(describeClickable),
    };
  }

  // mode === 'field' / 'fieldList'：依標籤文字找輸入欄。
  const selectorOf = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const name = element.getAttribute('name');
    if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    return null;
  };

  /** 可輸入的欄位（排除按鈕、勾選框等）。 */
  const inputsIn = (root) =>
    [...root.querySelectorAll('input, textarea')].filter((element) => {
      if (element.tagName === 'TEXTAREA') return true;
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'tel', 'number', ''].includes(type);
    });

  const describeField = (input, labelElement, matchedBy) => {
    const selector = selectorOf(input);
    if (!selector) return null;
    return {
      selector,
      labelText: (labelElement.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      visible: isVisible(input),
      matchedBy,
    };
  };

  if (params.mode === 'fieldList') {
    // 找不到目標欄位時，用這份清單回報「這一頁實際上有哪些輸入欄」，
    // 省下請使用者重跑一次探測的功夫。只取欄位本身與左側標籤，不取任何欄位值。
    return [...document.querySelectorAll('input, textarea')]
      .filter((element) => {
        if (element.tagName === 'TEXTAREA') return true;
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        return ['text', 'search', 'tel', 'number', ''].includes(type);
      })
      .map((element) => {
        const cell = element.closest('td, th');
        const previous = cell ? cell.previousElementSibling : null;
        return {
          selector: selectorOf(element) || '(沒有 id 也沒有 name)',
          nearbyText: mask(previous ? previous.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 30),
          visible: isVisible(element),
        };
      });
  }

  const wantedLabels = params.labels.map(normalize);
  const labelElements = [...document.querySelectorAll('td, th, label, span, div, b, font')].filter(
    (element) => {
      // 本身含輸入元件的節點是容器不是標籤，排除掉才不會抓到整張表格。
      if (element.querySelector('input, textarea, select')) return false;
      const text = normalize(element.textContent);
      if (!text || text.length > params.maxLabelLength) return false;
      return wantedLabels.some((label) => text.includes(label));
    },
  );

  // 依候選順序排序，讓精確的標籤先被試（例如「TEMSIS編號」優先於「TEMSIS」）。
  const rankOf = (element) => {
    const text = normalize(element.textContent);
    return wantedLabels.findIndex((label) => text.includes(label));
  };
  labelElements.sort((left, right) => rankOf(left) - rankOf(right));

  for (const labelElement of labelElements) {
    // 1) 標準關聯：<label for="...">
    if (labelElement.tagName === 'LABEL' && labelElement.htmlFor) {
      const target = document.getElementById(labelElement.htmlFor);
      const result = target && describeField(target, labelElement, 'label[for]');
      if (result) return result;
    }

    // 2) 表格版面：標籤在某個儲存格，欄位在後面的儲存格。
    const cell = labelElement.closest('td, th');
    let sibling = cell ? cell.nextElementSibling : null;
    while (sibling) {
      const input = inputsIn(sibling)[0];
      const result = input && describeField(input, labelElement, '同列的下一個儲存格');
      if (result) return result;
      sibling = sibling.nextElementSibling;
    }

    // 3) 退而求其次：同一列裡的第一個輸入欄。
    const row = labelElement.closest('tr');
    if (row) {
      const input = inputsIn(row)[0];
      const result = input && describeField(input, labelElement, '同一列');
      if (result) return result;
    }

    // 4) 非表格版面：往上找兩層容器內的第一個輸入欄。
    let container = labelElement.parentElement;
    for (let depth = 0; depth < 2 && container; depth += 1) {
      const input = inputsIn(container)[0];
      const result = input && describeField(input, labelElement, `父層容器（第 ${depth + 1} 層）`);
      if (result) return result;
      container = container.parentElement;
    }
  }
  return null;
}

/**
 * 依標籤文字找輸入欄。
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} labelCandidates 由前往後比對
 * @param {{maxLabelLength?: number}} [options]
 * @returns {Promise<FieldMatch|null>} 找不到時回傳 null（不猜欄位）
 */
export async function findField(frame, labelCandidates, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'field',
    labels: labelCandidates,
    // 標籤文字通常很短；30 字可容納「TEMSIS編號（可多筆）」這類含說明的標籤。
    maxLabelLength: options.maxLabelLength ?? 30,
  });
}

/**
 * 列出這一頁所有的輸入欄與其左側標籤（找不到目標欄位時的排查用）。
 * @param {import('playwright-core').Frame} frame
 * @returns {Promise<{selector:string, nearbyText:string, visible:boolean}[]>}
 */
export async function listFields(frame) {
  return frame.evaluate(queryPage, { mode: 'fieldList' });
}

/**
 * 列出這一頁所有可點擊元素的文字（去重，找不到目標按鈕時的排查用）。
 * @param {import('playwright-core').Frame} frame
 * @param {number} [limit] 最多列幾個
 * @returns {Promise<string[]>}
 */
export async function listClickableTexts(frame, limit = 40) {
  return frame.evaluate(queryPage, { mode: 'clickableTexts', limit });
}

/**
 * 把可點擊元素依「所在表格列」分組。
 *
 * 查詢結果一列就是一筆案件，但一列可能有好幾個按鈕
 * （「救護紀錄PDF」與「救護紀錄PDF(桃)」），直接數按鈕會把筆數算成兩倍。
 *
 * @param {ClickableMatch[]} matches
 * @returns {ClickableMatch[][]} 每組是同一列的元素，順序同原本的 document 順序
 */
export function groupByRow(matches) {
  /** @type {Map<number, ClickableMatch[]>} */
  const groups = new Map();
  for (const match of matches) {
    // rowIndex 為 -1 代表不在表格內，各自獨立成一組（用負的唯一鍵避免全部黏在一起）。
    const key = match.rowIndex >= 0 ? match.rowIndex : -1 - match.index;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }
  return [...groups.values()];
}

/**
 * 列出所有文字符合的可點擊元素。
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} textCandidates
 * @param {{onlyVisible?: boolean, exact?: boolean}} [options]
 *   exact＝true 時要求文字完全相同，用來區分「救護紀錄」與「救護紀錄PDF」
 * @returns {Promise<ClickableMatch[]>}
 */
export async function findClickables(frame, textCandidates, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'clickables',
    texts: textCandidates,
    exact: options.exact ?? false,
    onlyVisible: options.onlyVisible ?? true,
  });
}

/**
 * 點擊第 index 個文字符合的可點擊元素。
 * @returns {Promise<boolean>} 是否真的點到
 */
export async function clickMatch(frame, textCandidates, index = 0, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'click',
    texts: textCandidates,
    index,
    exact: options.exact ?? false,
    onlyVisible: options.onlyVisible ?? true,
  });
}

/**
 * 把「紀錄連結」與「解鎖按鈕」以所在的表格列配對。
 *
 * 案件內部有多張紀錄表時，必須確定「這個解鎖按鈕屬於哪一張紀錄表」，
 * 靠序號猜是不安全的（順序未必一致，猜錯就解到別張），因此以同一列為憑據。
 *
 * @returns {Promise<{pairs: {recordIndex:number, unlockIndex:number, recordText:string}[],
 *   recordCount:number, unlockCount:number, unlockTexts: ClickableMatch[]}>}
 */
export async function findPairedRows(frame, recordTexts, unlockTexts, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'pairs',
    recordTexts,
    unlockTexts,
    recordExact: options.recordExact ?? false,
    unlockExact: options.unlockExact ?? false,
  });
}
