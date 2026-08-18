/**
 * 通用頁面定位：全部以「人在畫面上看得到的文字」找元素，不依賴 id。
 *
 * 為什麼不用 id：這個系統的原始碼還沒探測過，而且政府系統改版常換 id；
 * 畫面文字才是使用者操作時真正依據的東西，比 id 穩定，出問題時也看得懂。
 *
 * ⚠ 個資原則：
 *   - 排查用的列表（欄位名、按鈕文字、下拉選項）屬**表單結構**，可安全記錄；
 *     但仍會遮蔽 5 碼以上的連續數字，避免身分證／電話混在文字裡被帶出來。
 *   - 資料列的內容一律不整列回傳，只回傳「有幾列」與命中的那一列的位置。
 *
 * 實作說明：所有 DOM 查找都在瀏覽器端由 {@link queryPage} 一次做完。
 * 它會被 `frame.evaluate` 序列化送進頁面，**因此不能引用這個模組以外的任何變數**，
 * 需要的工具函式都定義在它內部。
 */

/**
 * @typedef {Object} FieldMatch
 * @property {string} selector 可直接餵給 Playwright 的選擇器（沒有 id/name 時為空字串）
 * @property {string} tag input / select / textarea
 * @property {string} type input 的 type（select 為空字串）
 * @property {string} nearbyText 這個欄位旁邊看得到的文字（判斷有沒有找對用）
 * @property {string} matchedBy 命中的候選字
 * @property {boolean} visible
 */

/**
 * @typedef {Object} ClickableMatch
 * @property {number} index 第幾個（點擊時要傳回來的編號）
 * @property {string} text 元素上看得到的文字
 * @property {string} matchedBy 命中的候選字
 * @property {string} tag
 * @property {boolean} visible
 */

/** 在瀏覽器端執行的查找主體（不可引用外部變數）。 */
function queryPage(params) {
  const mode = params.mode;

  /** 把連續 5 碼以上的數字遮掉（身分證、電話、案號都可能夾在文字裡）。 */
  const maskDigits = (text) => String(text == null ? '' : text).replace(/\d{5,}/g, (hit) => hit.slice(0, 2) + '***');

  const clean = (text) => maskDigits(String(text == null ? '' : text).replace(/\s+/g, ' ').trim());

  /** 比對用：去掉所有空白（含全形），讓「MCI002 縣市端使用者」與「MCI002縣市端使用者」視為相同。 */
  const squeeze = (text) => String(text == null ? '' : text).replace(/[\s　]/g, '');

  const matches = (text, candidate, exact) =>
    exact ? squeeze(text) === squeeze(candidate) : squeeze(text).indexOf(squeeze(candidate)) >= 0;

  const isVisible = (element) => {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  /** 產生可餵給 Playwright 的選擇器；沒有 id/name 就回空字串（改用 index 操作）。 */
  const selectorOf = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    if (element.name) return element.tagName.toLowerCase() + '[name="' + CSS.escape(element.name) + '"]';
    return '';
  };

  /**
   * 這個欄位旁邊看得到的文字。
   *
   * 依序試七種版面寫法——實跑（2026-08-18）發現目標系統**不是**老式表格排版，
   * 只認 `td` 的話三個查詢欄位全部回報「沒有標籤」，等於誰都找不到：
   *   1. `label[for=id]`
   *   2. 包住欄位的 `<label>`
   *   3. 同一格（td/th）的前一格 → 老式表格排版
   *   4. 同一格內的文字（「姓名：<input>」）
   *   5. 前面的兄弟節點
   *   6. **同一個容器裡的 label／文字**（`<div><label>姓名</label><input></div>`）
   *   7. **往上兩層容器的前一個容器**（`<div class=col>姓名</div><div class=col><input></div>`）
   */
  const nearbyTextOf = (element) => {
    if (element.id) {
      const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      if (label && clean(label.textContent)) return clean(label.textContent);
    }
    const wrappingLabel = element.closest ? element.closest('label') : null;
    if (wrappingLabel && clean(wrappingLabel.textContent)) return clean(wrappingLabel.textContent);

    const cell = element.closest ? element.closest('td, th') : null;
    if (cell) {
      // 政府系統的老式表格排版：標籤在左邊那一格。
      let previous = cell.previousElementSibling;
      while (previous) {
        const text = clean(previous.textContent);
        if (text) return text;
        previous = previous.previousElementSibling;
      }
      // 標籤與欄位同在一格的寫法（例如「姓名：<input>」）。
      const own = clean(cell.textContent);
      if (own) return own;
    }
    let sibling = element.previousSibling;
    while (sibling) {
      const text = clean(sibling.textContent != null ? sibling.textContent : sibling.nodeValue);
      if (text) return text;
      sibling = sibling.previousSibling;
    }

    // 現代版面：往上找容器，看看同一個容器裡（或前一個容器裡）寫著什麼。
    let container = element.parentElement;
    for (let depth = 0; container && depth < 3; depth += 1) {
      const ownLabel = container.querySelector('label, .control-label, .field-label, legend');
      if (ownLabel && !ownLabel.contains(element)) {
        const text = clean(ownLabel.textContent);
        if (text) return text;
      }
      let previousBox = container.previousElementSibling;
      while (previousBox) {
        // 前一個容器若本身也含輸入欄，那是另一個欄位，不是這個欄位的標籤。
        if (!previousBox.querySelector('input, select, textarea')) {
          const text = clean(previousBox.textContent);
          if (text) return text;
        }
        previousBox = previousBox.previousElementSibling;
      }
      container = container.parentElement;
    }
    return '';
  };

  /** 欄位自己身上的提示文字（沒有標籤時，placeholder 往往就是唯一的線索）。 */
  const selfHintOf = (element) =>
    clean(
      [element.getAttribute('placeholder'), element.getAttribute('title'), element.getAttribute('aria-label')]
        .filter(Boolean)
        .join(' '),
    );

  /** 所有可輸入的欄位（隱藏欄不算）。 */
  const inputElements = () =>
    Array.prototype.slice
      .call(document.querySelectorAll('input, select, textarea'))
      .filter((element) => (element.getAttribute('type') || '').toLowerCase() !== 'hidden');

  const describeField = (element, matchedBy) => ({
    selector: selectorOf(element),
    tag: element.tagName.toLowerCase(),
    type: (element.getAttribute('type') || '').toLowerCase(),
    nearbyText: nearbyTextOf(element),
    // id／name／提示文字：標籤認不出來時，這些是判斷「這一欄到底是什麼」的線索。
    id: element.id || '',
    name: element.name || '',
    hint: selfHintOf(element),
    matchedBy: matchedBy || '',
    visible: isVisible(element),
  });

  /**
   * 這個欄位是不是「候選字說的那一欄」。
   *
   * 比對三個地方：旁邊的文字、欄位自己的提示（placeholder 等）、以及 id／name。
   * 標籤認不出來的版面上，`id="txtName"` 往往是唯一分得出欄位的東西。
   */
  const fieldMatchesLabel = (element, candidate, exact, maxLabelLength) => {
    const nearby = nearbyTextOf(element).replace(/[：:＊*]/g, '').trim();
    if (nearby && nearby.length <= maxLabelLength && matches(nearby, candidate, exact)) return true;
    const hint = selfHintOf(element);
    if (hint && matches(hint, candidate, exact)) return true;
    // id／name 是英文代碼，只在「非完全相符」那一輪比對，且要求候選字本身是英數
    // （中文候選拿去比對 id 沒有意義，只會誤中）。
    if (!exact && /^[A-Za-z0-9_]+$/.test(candidate)) {
      const code = (element.id + ' ' + (element.name || '')).toLowerCase();
      if (code && matches(code, candidate.toLowerCase(), false)) return true;
    }
    return false;
  };

  /** 元素上「看得到的文字」：優先自己的文字，其次 value / title / alt。 */
  const textOf = (element) => {
    const own = clean(element.textContent);
    if (own) return own;
    const attributes = ['value', 'title', 'alt', 'aria-label'];
    for (const attribute of attributes) {
      const text = clean(element.getAttribute ? element.getAttribute(attribute) : '');
      if (text) return text;
    }
    return '';
  };

  /** 可點擊的元素：連結、按鈕、圖片按鈕，以及掛了 onclick 的一般元素。 */
  const clickableElements = () =>
    Array.prototype.slice.call(
      document.querySelectorAll(
        'a, button, input[type="button"], input[type="submit"], input[type="image"],' +
          ' [onclick], [role="button"], [role="menuitem"], li, span, td, div',
      ),
    );

  /**
   * 找出文字符合的可點元素。
   *
   * 會**排除掉「還包著其他命中元素」的外層容器**：`div`、`td` 都在候選裡，
   * 不排除的話點到的會是整個區塊而不是那顆按鈕。
   */
  const findClickables = (texts, exact, onlyVisible) => {
    const hits = [];
    for (const element of clickableElements()) {
      if (onlyVisible && !isVisible(element)) continue;
      const text = textOf(element);
      if (!text) continue;
      let matchedBy = '';
      for (const candidate of texts) {
        if (matches(text, candidate, exact)) {
          matchedBy = candidate;
          break;
        }
      }
      if (!matchedBy) continue;
      hits.push({ element, text, matchedBy });
    }
    return hits.filter((hit) => !hits.some((other) => other !== hit && hit.element.contains(other.element)));
  };

  const describeClickable = (hit, index) => ({
    index,
    text: hit.text,
    matchedBy: hit.matchedBy,
    tag: hit.element.tagName.toLowerCase(),
    visible: isVisible(hit.element),
  });

  /** 真的按下去：先捲到畫面內，再觸發原生 click。 */
  const clickElement = (element) => {
    if (element.scrollIntoView) element.scrollIntoView({ block: 'center' });
    element.click();
    return true;
  };

  if (mode === 'fieldList') {
    return inputElements().map((element) => describeField(element));
  }

  if (mode === 'field') {
    const fields = inputElements();
    const maxLabelLength = params.maxLabelLength || 30;
    // 候選字由前往後比對，且**先找完全相同的標籤再找包含**：
    // 「帳號」若用包含比對會命中「帳號關鍵字」，那是另一個欄位。
    for (const candidate of params.labels) {
      for (const exact of [true, false]) {
        const hit = fields.find((element) => {
          if (params.onlyVisible !== false && !isVisible(element)) return false;
          if (params.tag && element.tagName.toLowerCase() !== params.tag) return false;
          return fieldMatchesLabel(element, candidate, exact, maxLabelLength);
        });
        if (hit) return describeField(hit, candidate);
      }
    }
    return null;
  }

  if (mode === 'setField') {
    // 依標籤找到欄位後**直接在瀏覽器端設值**：這個系統的欄位不一定有 id 或 name，
    // 沒有選擇器就沒辦法交給 Playwright 填，只能在這裡填完再回報填了哪一欄。
    const fields = inputElements();
    const maxLabelLength = params.maxLabelLength || 30;
    for (const candidate of params.labels) {
      for (const exact of [true, false]) {
        const hit = fields.find((element) => {
          if (!isVisible(element)) return false;
          if (params.tag && element.tagName.toLowerCase() !== params.tag) return false;
          return fieldMatchesLabel(element, candidate, exact, maxLabelLength);
        });
        if (!hit) continue;
        hit.focus();
        hit.value = params.value == null ? '' : String(params.value);
        hit.dispatchEvent(new Event('input', { bubbles: true }));
        hit.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, nearbyText: nearbyTextOf(hit), matchedBy: candidate, selector: selectorOf(hit) };
      }
    }
    return { ok: false, reason: '找不到這個欄位' };
  }

  if (mode === 'clickables') {
    return findClickables(params.texts, params.exact === true, params.onlyVisible !== false).map(describeClickable);
  }

  if (mode === 'click') {
    const hits = findClickables(params.texts, params.exact === true, params.onlyVisible !== false);
    const target = hits[params.index || 0];
    if (!target) return false;
    return clickElement(target.element);
  }

  if (mode === 'clickableList') {
    const seen = {};
    const result = [];
    for (const element of clickableElements()) {
      if (!isVisible(element)) continue;
      const text = textOf(element);
      if (!text || text.length > 40 || seen[text]) continue;
      // 外層容器的文字往往是一整片區塊，對排查沒有幫助。
      if (element.querySelector && element.querySelector('a, button, input, select')) continue;
      seen[text] = true;
      result.push({ text, tag: element.tagName.toLowerCase() });
      if (result.length >= (params.limit || 60)) break;
    }
    return result;
  }

  if (mode === 'selects') {
    return Array.prototype.slice
      .call(document.querySelectorAll('select'))
      .slice(0, params.limit || 40)
      .map((element) => ({
        selector: selectorOf(element),
        nearbyText: nearbyTextOf(element),
        id: element.id || '',
        name: element.name || '',
        hint: selfHintOf(element),
        visible: isVisible(element),
        optionCount: element.options.length,
        // 選項名稱屬表單結構（單位清單、角色清單），可安全記錄；仍遮蔽長數字。
        options: Array.prototype.slice
          .call(element.options)
          .slice(0, params.optionLimit || 400)
          .map((option) => clean(option.textContent)),
      }));
  }

  /**
   * 在一個 select 裡選出文字相符的選項。
   *
   * **先找完全相同、再找包含**，且多筆相符時一律不選：
   * 幫人開錯單位或開錯角色，比查不到人嚴重得多。
   */
  const chooseOption = (element, texts) => {
    const options = Array.prototype.slice.call(element.options);
    for (const exact of [true, false]) {
      for (const candidate of texts) {
        const hits = options.filter((option) => matches(clean(option.textContent), candidate, exact));
        if (hits.length === 1) {
          element.value = hits[0].value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, chosen: clean(hits[0].textContent), matchedBy: candidate, ambiguous: [] };
        }
        if (hits.length > 1) {
          return {
            ok: false,
            reason: '相符的選項不只一個',
            ambiguous: hits.slice(0, 10).map((option) => clean(option.textContent)),
          };
        }
      }
    }
    return {
      ok: false,
      reason: '沒有相符的選項',
      ambiguous: options.slice(0, 30).map((option) => clean(option.textContent)),
    };
  };

  if (mode === 'selectOption') {
    const labels = params.labels || [];
    const element = params.selector
      ? document.querySelector(params.selector)
      : Array.prototype.slice
          .call(document.querySelectorAll('select'))
          .find(
            (candidate) =>
              isVisible(candidate) && labels.some((label) => fieldMatchesLabel(candidate, label, false, 30)),
          );
    if (!element) return { ok: false, reason: '找不到下拉選單', ambiguous: [] };
    return chooseOption(element, params.texts);
  }

  if (mode === 'selectAnywhere') {
    // 「選項裡有這個字的那個下拉」——用在不知道欄位叫什麼、但知道要選什麼的時候
    // （登入頁的縣市別就是這樣：整頁不會有第二個下拉含「桃園市」）。
    const selects = Array.prototype.slice.call(document.querySelectorAll('select')).filter(isVisible);
    for (const element of selects) {
      const result = chooseOption(element, params.texts);
      if (result.ok) return { ...result, selector: selectorOf(element) };
    }
    return {
      ok: false,
      reason: selects.length === 0 ? '這一頁沒有看得見的下拉選單' : '每個下拉都找不到相符的選項',
      ambiguous: selects
        .slice(0, 5)
        .flatMap((element) =>
          Array.prototype.slice.call(element.options).slice(0, 8).map((option) => clean(option.textContent)),
        ),
    };
  }

  if (mode === 'rowSelectOption') {
    // 「某個項目旁邊的下拉」：先鎖定那一列，再在列內找 select。
    const rows = Array.prototype.slice
      .call(document.querySelectorAll('tr, li, div'))
      .filter(
        (row) =>
          isVisible(row) &&
          row.querySelector('select') &&
          params.rowTexts.some((candidate) => matches(clean(row.textContent), candidate, false)),
      );
    const innermost = rows.filter((row) => !rows.some((other) => other !== row && row.contains(other)));
    if (innermost.length === 0) return { ok: false, reason: '找不到「含該項目又有下拉」的那一列', ambiguous: [] };
    const element = innermost[0].querySelector('select');
    const result = chooseOption(element, params.texts);
    return { ...result, rowCount: innermost.length };
  }

  if (mode === 'rowAction') {
    // 找出「含指定文字的那一列」，再在那一列裡面找可以按的東西。
    const rows = Array.prototype.slice.call(document.querySelectorAll('tr, li'));
    const targetRows = rows.filter(
      (row) =>
        isVisible(row) && params.rowTexts.some((candidate) => matches(clean(row.textContent), candidate, false)),
    );
    // 只留最內層的列（表格巢狀時，外層的 tr 也會命中）。
    const innermost = targetRows.filter((row) => !targetRows.some((other) => other !== row && row.contains(other)));
    if (innermost.length === 0) return { ok: false, reason: '找不到含該文字的那一列', rowCount: 0 };
    if (innermost.length > 1 && params.requireUnique) {
      return { ok: false, reason: '含該文字的列不只一列', rowCount: innermost.length };
    }
    const row = innermost[0];
    const candidates = Array.prototype.slice.call(
      row.querySelectorAll(
        'a, button, input[type="button"], input[type="submit"], input[type="image"], input[type="checkbox"], input[type="radio"], [onclick], select',
      ),
    );
    const actions = candidates.filter((element) => {
      if (!isVisible(element)) return false;
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute('type') || '').toLowerCase();
      // 勾選框與單選鈕**點下去會切換狀態**：已經勾好的權限會被取消。
      // 這個判斷必須排在「沒指定文字就全收」之前，否則等於沒生效。
      if (params.skipToggles && (type === 'checkbox' || type === 'radio')) return false;
      if (!params.actionTexts || params.actionTexts.length === 0) return true;
      // 下拉、勾選框、單選鈕沒有自己的文字，只要在那一列就算候選。
      if (tag === 'select' || type === 'checkbox' || type === 'radio') return true;
      return params.actionTexts.some((candidate) => matches(textOf(element), candidate, false));
    });
    if (actions.length === 0) {
      return { ok: false, reason: '那一列裡找不到可以按的東西', rowCount: innermost.length };
    }
    const target = actions[params.actionIndex || 0];
    if (!target) {
      return { ok: false, reason: '那一列裡沒有第 ' + (params.actionIndex + 1) + ' 個可按的東西', rowCount: innermost.length, actionCount: actions.length };
    }
    const described = {
      ok: true,
      rowCount: innermost.length,
      actionCount: actions.length,
      actionText: textOf(target),
      actionTag: target.tagName.toLowerCase(),
      actionType: (target.getAttribute('type') || '').toLowerCase(),
      actionSelector: selectorOf(target),
    };
    if (params.dryRun) return described;
    clickElement(target);
    return described;
  }

  if (mode === 'dataRowCount') {
    // 查詢結果有幾列：只數列數，**不回傳任何一列的內容**（那是個資）。
    const tables = Array.prototype.slice.call(document.querySelectorAll('table')).filter(isVisible);
    let best = 0;
    for (const table of tables) {
      const bodyRows = Array.prototype.slice
        .call(table.querySelectorAll('tr'))
        .filter((row) => isVisible(row) && row.querySelectorAll('td').length > 0);
      if (bodyRows.length > best) best = bodyRows.length;
    }
    return best;
  }

  if (mode === 'matchText') {
    // 只回傳比對到的那一小段（例如筆數的數字），**不回傳整頁文字**——
    // 這一頁的表格裡是人事資料，整頁文字屬個資，不能帶出來。
    const body = document.body ? document.body.innerText : '';
    const found = body.match(new RegExp(params.pattern));
    if (!found) return '';
    return found[1] != null ? found[1] : found[0];
  }

  if (mode === 'hasText') {
    const body = clean(document.body ? document.body.innerText : '');
    for (const candidate of params.texts) {
      if (matches(body, candidate, false)) return candidate;
    }
    return '';
  }

  if (mode === 'loginFields') {
    const password = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).find(isVisible);
    if (!password) return null;
    const form = password.closest('form') || document;
    const textInputs = Array.prototype.slice.call(form.querySelectorAll('input')).filter((element) => {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'tel', 'email', ''].indexOf(type) >= 0 && isVisible(element);
    });
    const looksLikeCaptcha = (element) => {
      const haystack = squeeze(
        [element.id, element.name, nearbyTextOf(element), element.getAttribute('placeholder')].join(' '),
      ).toLowerCase();
      return params.captchaHints.some((hint) => haystack.indexOf(squeeze(hint).toLowerCase()) >= 0);
    };
    const captcha = textInputs.find(looksLikeCaptcha) || null;
    // 帳號欄＝排在密碼欄前面、且不是驗證碼欄的那個文字欄。
    const username =
      textInputs.find(
        (element) =>
          element !== captcha &&
          (element.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      ) ||
      textInputs.find((element) => element !== captcha) ||
      null;
    const submit =
      Array.prototype.slice
        .call(form.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a'))
        .find(
          (element) =>
            isVisible(element) && params.submitTexts.some((candidate) => matches(textOf(element), candidate, false)),
        ) || null;
    return {
      username: username ? describeField(username) : null,
      password: describeField(password),
      captcha: captcha ? describeField(captcha) : null,
      submit: submit ? { text: textOf(submit), selector: selectorOf(submit) } : null,
    };
  }

  throw new Error('未知的查找模式：' + mode);
}

/**
 * 依標籤文字找輸入欄。
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} labelCandidates 由前往後比對，最精確的放前面
 * @param {{tag?: string, maxLabelLength?: number, onlyVisible?: boolean}} [options]
 * @returns {Promise<FieldMatch|null>} 找不到時回傳 null（不猜欄位）
 */
export async function findField(frame, labelCandidates, options = {}) {
  return frame.evaluate(queryPage, { mode: 'field', labels: labelCandidates, ...options });
}

/**
 * 列出這一頁所有欄位與旁邊的文字（找不到目標欄位時的排查用）。
 * @param {import('playwright-core').Frame} frame
 * @returns {Promise<FieldMatch[]>}
 */
export async function listFields(frame) {
  return frame.evaluate(queryPage, { mode: 'fieldList' });
}

/**
 * 列出所有文字符合的可點擊元素。
 * @param {{exact?: boolean, onlyVisible?: boolean}} [options]
 * @returns {Promise<ClickableMatch[]>}
 */
export async function findClickables(frame, textCandidates, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'clickables',
    texts: textCandidates,
    exact: options.exact === true,
    onlyVisible: options.onlyVisible !== false,
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
    exact: options.exact === true,
    onlyVisible: options.onlyVisible !== false,
  });
}

/**
 * 依標籤文字找到欄位並填值（值為空字串即清空）。
 *
 * 為什麼不用 Playwright 的 `fill`：那需要選擇器，而這個系統的欄位不保證有 id 或 name。
 * ⚠ 填入的值可能是姓名（個資），本函式**不記錄值本身**，只回報填到哪一個欄位。
 *
 * @returns {Promise<{ok:boolean, nearbyText?:string, matchedBy?:string, selector?:string, reason?:string}>}
 */
export async function setField(frame, labelCandidates, value, options = {}) {
  return frame.evaluate(queryPage, { mode: 'setField', labels: labelCandidates, value, ...options });
}

/** 列出畫面上可點的文字（排查用；已遮蔽長數字）。 */
export async function listClickableTexts(frame, limit = 60) {
  return frame.evaluate(queryPage, { mode: 'clickableList', limit });
}

/** 列出所有下拉選單與其選項（排查用；選項名稱屬表單結構）。 */
export async function listSelects(frame, options = {}) {
  return frame.evaluate(queryPage, { mode: 'selects', ...options });
}

/**
 * 在下拉選單中選出文字相符的選項。
 *
 * 多筆相符時**不選**，回報候選讓使用者把名稱寫完整——
 * 幫人開錯單位的權限，比查不到人嚴重得多。
 *
 * @param {string} selector 下拉的選擇器；空字串代表改用 labels 找
 * @returns {Promise<{ok:boolean, chosen?:string, matchedBy?:string, reason?:string, ambiguous?:string[]}>}
 */
export async function selectOptionByText(frame, selector, textCandidates, labels = []) {
  return frame.evaluate(queryPage, { mode: 'selectOption', selector, texts: textCandidates, labels });
}

/**
 * 在整頁的下拉裡找出「有這個選項」的那一個並選它。
 *
 * 用在**知道要選什麼、但不知道欄位叫什麼**的場合——登入頁的縣市別就是這樣：
 * 那一欄沒有可靠的標籤，但整頁不會有第二個下拉含「桃園市」。
 *
 * @returns {Promise<{ok:boolean, chosen?:string, selector?:string, reason?:string, ambiguous?:string[]}>}
 */
export async function selectOptionAnywhere(frame, textCandidates) {
  return frame.evaluate(queryPage, { mode: 'selectAnywhere', texts: textCandidates });
}

/**
 * 在「含指定項目的那一列」的下拉選單裡選出角色。
 *
 * 對應的是「MCI大量傷病患救護管理系統 旁邊的那個下拉」這種版面：
 * 整頁有很多個一模一樣的下拉，只有所在的列不同，靠列文字才分得出是哪一個。
 *
 * @returns {Promise<{ok:boolean, chosen?:string, reason?:string, ambiguous?:string[], rowCount?:number}>}
 */
export async function selectOptionInRow(frame, rowTexts, textCandidates) {
  return frame.evaluate(queryPage, { mode: 'rowSelectOption', rowTexts, texts: textCandidates });
}

/**
 * 在「含指定文字的那一列」裡按下動作按鈕。
 * @param {{rowTexts:string[], actionTexts?:string[], actionIndex?:number,
 *   requireUnique?:boolean, dryRun?:boolean, skipToggles?:boolean}} options
 *   `skipToggles`＝不要把勾選框／單選鈕當成候選（點下去會切換狀態，
 *   可能把已經勾好的權限取消掉）
 * @returns {Promise<{ok:boolean, reason?:string, rowCount:number, actionCount?:number,
 *   actionText?:string, actionTag?:string, actionType?:string, actionSelector?:string}>}
 */
export async function rowAction(frame, options) {
  return frame.evaluate(queryPage, { mode: 'rowAction', ...options });
}

/** 目前畫面上最大的表格有幾列資料（只數列數，不取內容）。 */
export async function countDataRows(frame) {
  return frame.evaluate(queryPage, { mode: 'dataRowCount' });
}

/**
 * 用樣式比對畫面文字，回傳命中的那一小段（有括號群組就回傳第一組）。
 *
 * 給「顯示第 1 至 10 項結果，共 26 項」這種筆數文字用：**系統自己講的筆數**
 * 比數畫面上有幾個按鈕可靠（按鈕會被分頁切掉）。
 *
 * ⚠ 只回傳命中的片段，不回傳整頁文字（那一頁的表格內容是個資）。
 *
 * @param {RegExp|string} pattern
 * @returns {Promise<string>} 沒命中時為空字串
 */
export async function matchText(frame, pattern) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  return frame.evaluate(queryPage, { mode: 'matchText', pattern: source });
}

/**
 * 畫面上是否出現這些字樣之一（用來認系統的錯誤訊息）。
 * @returns {Promise<string>} 命中的字樣；沒有則為空字串
 */
export async function hasText(frame, textCandidates) {
  return frame.evaluate(queryPage, { mode: 'hasText', texts: textCandidates });
}

/**
 * 認出登入表單的各個欄位（以密碼欄為錨點）。
 * @returns {Promise<{username:FieldMatch|null, password:FieldMatch,
 *   captcha:FieldMatch|null, submit:{text:string, selector:string}|null}|null>}
 */
export async function findLoginFields(frame, hints) {
  return frame.evaluate(queryPage, {
    mode: 'loginFields',
    captchaHints: hints.captchaHints,
    submitTexts: hints.submitTexts,
  });
}

export { queryPage };
