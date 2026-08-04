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

  if (params.mode === 'rowFields') {
    // 讀取「某個按鈕所在的那一列」的指定欄位。
    // 表格有標題列可以對照，比從 PDF 硬抓可靠得多
    // （PDF 的文字順序是「標題1 標題2 … 值1 值2 …」，抓標籤後面的字會抓到下一個標題）。
    const target = collectClickables(params.texts, params.exact, true)[params.index];
    if (!target) return null;
    const row = target.closest('tr');
    const table = row ? row.closest('table') : null;
    if (!row || !table) return null;

    const textOf = (cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim();
    // 標題列：優先找含 <th> 的列，沒有就用表格第一列。
    const headerRow = [...table.rows].find((item) => item.querySelector('th')) || table.rows[0];
    const headers = headerRow && headerRow !== row ? [...headerRow.cells].map(textOf) : [];
    const cells = [...row.cells].map(textOf);

    // ⚠ 個資：**只回傳指定欄位的值**，其餘儲存格內容一律不帶出去。
    const values = {};
    for (const wanted of params.wantedHeaders) {
      const index = headers.findIndex((header) => normalize(header).includes(normalize(wanted)));
      if (index >= 0 && cells[index] !== undefined) values[wanted] = cells[index].slice(0, 40);
    }
    return { headers, values, columnCount: cells.length };
  }

  if (params.mode === 'click') {
    const target = collectClickables(params.texts, params.exact, params.onlyVisible)[params.index];
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }

  /**
   * 一個元素「旁邊看得到的文字」的所有可能出處，附上**距離**。
   *
   * 舊系統的勾選框標籤沒有固定寫法：可能包在 `<label>` 裡、可能就寫在同一格
   * （`<td><input>EKG檢查</td>`）、也可能在左右相鄰的儲存格（`<td>血糖檢查</td><td><input></td>`）。
   * 四種都要收，但**距離必須分級**：
   * 同一列的隔壁格文字，對「我自己」和「隔壁那個勾選框」來說都讀得到，
   * 不分距離的話，`<td><input A>氣管內管</td><td><input B>EKG檢查</td>` 會讓 A
   * 因為讀得到隔壁的「EKG檢查」而搶在 B 前面被選中（實測踩到）。
   *
   * distance 0＝就是這個元素自己的標籤；1＝隔壁格或相鄰節點。
   */
  const nearbyTextsOf = (element) => {
    const texts = [];
    const push = (value, distance) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (text) texts.push({ text, distance });
    };

    if (element.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (explicit) push(explicit.textContent, 0);
    }
    const wrapping = element.closest('label');
    if (wrapping) push(wrapping.textContent, 0);

    const cell = element.closest('td, th');
    if (cell) {
      push(cell.textContent, 0);
      push(cell.nextElementSibling?.textContent, 1);
      push(cell.previousElementSibling?.textContent, 1);
    }
    // 非表格版面：緊鄰的前後文字節點（`<input><span>EKG檢查</span>` 這種寫法）。
    push(element.nextElementSibling?.textContent, 1);
    push(element.nextSibling?.nodeType === 3 ? element.nextSibling.textContent : '', 1);
    return texts;
  };

  /** 只取文字（供排查清單顯示）。 */
  const firstNearbyText = (element) => nearbyTextsOf(element)[0]?.text ?? '';

  /**
   * 依「旁邊的文字」比對一組候選標籤，回傳命中的候選序號與比對方式。
   *
   * 分數越小越好，三個條件依重要性排序：
   *   1. 候選序號（設定檔把最精確的字樣排前面，這個最優先）
   *   2. 距離（自己的標籤勝過隔壁格的標籤）
   *   3. 完全相等勝過包含
   */
  const rankByLabels = (entries, wantedLabels) => {
    let best = null;
    for (const { text, distance } of entries) {
      const normalized = normalize(text);
      if (!normalized) continue;
      for (const [rank, label] of wantedLabels.entries()) {
        if (!label) continue;
        const exact = normalized === label;
        const hit = exact || normalized.includes(label);
        if (!hit) continue;
        const score = rank * 4 + distance * 2 + (exact ? 0 : 1);
        if (!best || score < best.score) {
          best = { score, rank, exact, distance, text: text.slice(0, 30) };
        }
      }
    }
    return best;
  };

  /** 勾選框（含單選鈕），排除按鈕類的 input。 */
  const checkboxesIn = () =>
    [...document.querySelectorAll('input')].filter((element) =>
      ['checkbox', 'radio'].includes((element.getAttribute('type') || '').toLowerCase()),
    );

  if (params.mode === 'checkbox' || params.mode === 'checkboxList') {
    // 這個系統有大量**同名**的勾選框（`_scar`、`_nScar`… 一組幾十個共用一個 name），
    // 用 name 當選擇器會一次選到一整群。沒有 id 就不回傳選擇器——
    // 寧可回報找不到，也不要勾錯一個而讓整份統計失真。
    const selectorOfInput = (element) => (element.id ? `#${CSS.escape(element.id)}` : null);

    if (params.mode === 'checkboxList') {
      // 找不到目標勾選框時，回報「這一頁的勾選框旁邊各自寫著什麼」。
      // ⚠ 個資：只取標籤文字（表單結構），且已遮蔽長數字並截斷。
      const seen = new Set();
      const listed = [];
      for (const element of checkboxesIn()) {
        const text = mask(firstNearbyText(element)).slice(0, 24);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        listed.push(text);
        if (listed.length >= params.limit) break;
      }
      return listed;
    }

    const wantedLabels = params.labels.map(normalize);
    let bestMatch = null;
    for (const element of checkboxesIn()) {
      const selector = selectorOfInput(element);
      if (!selector) continue;
      const ranked = rankByLabels(nearbyTextsOf(element), wantedLabels);
      if (!ranked) continue;
      if (!bestMatch || ranked.score < bestMatch.score) {
        bestMatch = {
          score: ranked.score,
          selector,
          labelText: ranked.text,
          exact: ranked.exact,
          checked: element.checked,
          visible: isVisible(element),
          matchedBy: ranked.exact ? '旁邊的文字完全相符' : '旁邊的文字包含此字樣',
        };
      }
    }
    if (!bestMatch) return null;
    const { score, ...result } = bestMatch;
    return result;
  }

  if (params.mode === 'rowsWithColumnValue') {
    // 找出「某一欄有值」的列，例如傳輸紀錄裡 EKG 那一欄不是空的那幾列。
    //
    // 為什麼需要這個而不是用文字找列：傳輸紀錄的 EKG 是**欄位標題**，
    // 資料列裡放的是量測數值，用「內容含 EKG」去找永遠找不到（實測踩過）。
    //
    // ⚠ 個資：**只回傳 `wantedHeaders` 命中的欄位值**，其餘儲存格一律不帶出去。
    const wantedColumn = params.columnCandidates.map(normalize);
    const results = [];
    for (const table of document.querySelectorAll('table')) {
      const headerRow = [...table.rows].find((item) => item.querySelector('th')) || table.rows[0];
      if (!headerRow) continue;
      const headers = [...headerRow.cells].map((cell) =>
        (cell.textContent || '').replace(/\s+/g, ' ').trim(),
      );
      // 欄名以**完全相等**比對：`EKG` 若用包含比對會連「EKG判讀狀態」一起命中。
      const columnIndex = headers.findIndex((header) => wantedColumn.includes(normalize(header)));
      if (columnIndex < 0) continue;

      const wantedValues = (params.valueMarkers ?? []).map(normalize);
      for (const row of table.rows) {
        if (row === headerRow) continue;
        const cells = [...row.cells];
        const marker = (cells[columnIndex]?.textContent || '').replace(/\s+/g, ' ').trim();
        // 空白、`-`、`無` 都當作「這一列沒有做」。
        if (!marker || ['-', '－', '無', 'N/A'].includes(marker)) continue;
        // 有指定 valueMarkers 時，這一欄的**值**還要對得上才算數。
        // 上傳清單就是這樣用的：只認「檔案類型」欄寫著 12導程 的列，
        // 不能讓備註欄的「ZOLL12導程附檔上傳」之類的字樣矇混過關。
        if (wantedValues.length > 0 && !wantedValues.some((want) => normalize(marker).includes(want))) {
          continue;
        }

        const values = {};
        for (const wanted of params.wantedHeaders) {
          const index = headers.findIndex((header) => normalize(header).includes(normalize(wanted)));
          if (index >= 0 && cells[index]) {
            values[wanted] = mask(cells[index].textContent || '')
              .replace(/\s+/g, ' ').trim().slice(0, 40);
          }
        }
        results.push({ marker: mask(marker).slice(0, 20), values });
        if (results.length >= params.maxRows) return { headers, matched: results };
      }
      return { headers, matched: results };
    }
    return { headers: [], matched: [] };
  }

  if (params.mode === 'tableHeaders') {
    // 找不到目標時，回報「這一頁有哪些表格、各自的欄位叫什麼」。
    // ⚠ 個資：**只取標題列**，資料列一個都不碰（與探測模式同一套規則）。
    const described = [];
    for (const table of document.querySelectorAll('table')) {
      const headerRow = [...table.rows].find((item) => item.querySelector('th')) || table.rows[0];
      if (!headerRow) continue;
      const headers = [...headerRow.cells]
        .map((cell) => mask(cell.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20))
        .filter(Boolean);
      // 只有一格的多半是版面用的表格，不是資料表。
      if (headers.length < 2) continue;
      described.push(`[${headers.join('｜')}]（${table.rows.length} 列）`);
      if (described.length >= params.limit) break;
    }
    return described;
  }

  if (params.mode === 'markedRows') {
    // 取出「含有指定字樣」的表格列，例如傳輸紀錄畫面中寫著「12導程」的那幾列。
    //
    // ⚠ 個資：這是本模組唯一會帶出資料格內容的模式，因為判斷「上傳時間在不在到院之前」
    //   非做不可。防護作法：只回傳**命中字樣的那幾列**（不是整張表）、每格截斷、
    //   5 碼以上連續數字遮蔽（時間戳記被 `/`、`:` 隔開，不受影響）。
    //   呼叫端用完即棄，不落檔（見 ekgVerify.mjs）。
    const wanted = params.markers.map(normalize);

    /**
     * 取文字時**把下拉選單的內容拿掉**。
     *
     * 查詢頁的「心電圖」下拉本身就有一個叫「12導程心電圖」的選項，
     * 不排除的話，那一整列查詢條件會被當成一筆 12 導程的上傳紀錄
     * （實測踩到：一張假頁面上抓出 3 列，其中一列是查詢表單）。
     * 下拉是「可以選什麼」，不是「這件案子做了什麼」，本來就不該算數。
     */
    const visibleTextOf = (node) => {
      const clone = node.cloneNode(true);
      for (const control of clone.querySelectorAll('select, option, datalist, script, style')) {
        control.remove();
      }
      return clone.textContent || '';
    };
    const textOf = (cell) =>
      mask(visibleTextOf(cell)).replace(/\s+/g, ' ').trim().slice(0, params.maxCellLength);

    const collected = [];
    let headers = [];
    let scanned = 0;
    for (const table of document.querySelectorAll('table')) {
      const headerRow = [...table.rows].find((item) => item.querySelector('th')) || table.rows[0];
      for (const row of table.rows) {
        if (row === headerRow) continue;
        scanned += 1;
        const rowText = normalize(visibleTextOf(row));
        if (!wanted.some((marker) => rowText.includes(marker))) continue;
        if (headers.length === 0 && headerRow && headerRow !== row) {
          headers = [...headerRow.cells].map(textOf);
        }
        collected.push([...row.cells].map(textOf));
        if (collected.length >= params.maxRows) return { headers, rows: collected, scanned };
      }
    }
    return { headers, rows: collected, scanned };
  }

  if (params.mode === 'selectByOption' || params.mode === 'selectList') {
    const selects = [...document.querySelectorAll('select')];

    if (params.mode === 'selectList') {
      // ⚠ 個資：下拉選項屬系統代碼表（分隊、狀態…），非個人資料，可安全列出；
      //   這裡只取每個下拉的 id 與前幾個選項，供比對是哪一個欄位。
      return selects.slice(0, params.limit).map((element) => ({
        selector: element.id ? `#${element.id}` : '(沒有 id)',
        nearbyText: mask(firstNearbyText(element)).slice(0, 24),
        optionCount: element.options.length,
        sampleOptions: [...element.options].slice(0, 6).map((option) => mask(option.textContent).trim().slice(0, 16)),
      }));
    }

    const wantedTexts = params.optionTexts.map(normalize);
    let bestMatch = null;
    for (const element of selects) {
      if (!element.id) continue; // 沒有 id 就無法穩定指定，不猜
      for (const option of element.options) {
        const normalized = normalize(option.textContent);
        if (!normalized) continue;
        for (const [rank, wanted] of wantedTexts.entries()) {
          const exact = normalized === wanted;
          if (!exact && !normalized.includes(wanted)) continue;
          const score = rank * 2 + (exact ? 0 : 1);
          if (bestMatch && score >= bestMatch.score) continue;
          bestMatch = {
            score,
            selector: `#${element.id}`,
            optionValue: option.value,
            optionText: option.textContent.replace(/\s+/g, ' ').trim().slice(0, 30),
            nearbyText: firstNearbyText(element).slice(0, 30),
            visible: isVisible(element),
            matchedBy: exact ? '選項文字完全相符' : '選項文字包含此字樣',
          };
        }
      }
    }
    if (!bestMatch) return null;
    const { score, ...result } = bestMatch;
    return result;
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
 * 依「旁邊看得到的文字」找勾選框。
 *
 * 為什麼不用 id：救護紀錄表查詢頁有 400 多個勾選框，id 全是 `_scarcbc040102`
 * 這種代碼，光看 id 完全無從得知哪一個是「EKG檢查」。改用人看畫面的方式定位，
 * 系統改版換 id 也不會壞。
 *
 * **沒有 id 的勾選框一律不回傳**：這個系統有大量同名的勾選框，
 * 用 name 當選擇器會一次選到一整群而勾錯。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} labelCandidates 由前往後比對，最精確的放前面
 * @returns {Promise<{selector:string, labelText:string, checked:boolean,
 *   visible:boolean, matchedBy:string}|null>} 找不到時回傳 null（不猜欄位）
 */
export async function findCheckbox(frame, labelCandidates) {
  return frame.evaluate(queryPage, { mode: 'checkbox', labels: labelCandidates });
}

/**
 * 列出這一頁所有勾選框旁邊的文字（找不到目標勾選框時的排查用）。
 * ⚠ 只取標籤文字（表單結構），數字已遮蔽。
 * @returns {Promise<string[]>}
 */
export async function listCheckboxLabels(frame, limit = 60) {
  return frame.evaluate(queryPage, { mode: 'checkboxList', limit });
}

/**
 * 依**選項文字**反推是哪一個下拉選單。
 *
 * 為什麼不找標籤：這一頁有 20 幾個下拉，標籤又常常只是隔壁儲存格的一段文字；
 * 而「12導程心電圖」這種選項只會出現在唯一一個下拉裡，用選項反推精確得多，
 * 系統把標籤從「心電圖」改成「心電圖類型」也不受影響。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} optionTextCandidates 由前往後比對，最精確的放前面
 * @returns {Promise<{selector:string, optionValue:string, optionText:string,
 *   nearbyText:string, visible:boolean, matchedBy:string}|null>}
 */
export async function findSelectByOption(frame, optionTextCandidates) {
  return frame.evaluate(queryPage, { mode: 'selectByOption', optionTexts: optionTextCandidates });
}

/**
 * 找出「某一欄有值」的列，並取回指定欄位的值。
 *
 * 用途：傳輸紀錄那張生命徵象表裡，找出 **EKG 那一欄不是空的**那幾列，
 * 取它們的量測時間。那張表的 EKG 是欄位標題、資料列裡是量測數值，
 * 用「內容含 EKG」的方式找列永遠找不到（2026-08-04 實測踩過）。
 *
 * ⚠ 個資：只回傳 `wantedHeaders` 命中的欄位值，其餘儲存格不帶出去；長數字已遮蔽。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} columnCandidates 目標欄名（**完全相等**比對，避免 `EKG` 命中「EKG判讀狀態」）
 * @param {string[]} wantedHeaders 要取回的欄位名稱（以「包含」比對）
 * @param {{maxRows?: number, valueMarkers?: string[]}} [options]
 *   `valueMarkers`：不給就是「這一欄只要有值就算」（傳輸紀錄的 EKG 欄用法）；
 *   給了就要求該欄的**值**含有其中之一（上傳清單的「檔案類型＝12導程心電圖」用法）
 * @returns {Promise<{headers: string[], matched: {marker: string, values: Record<string,string>}[]}>}
 */
export async function findRowsWithColumnValue(frame, columnCandidates, wantedHeaders, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'rowsWithColumnValue',
    columnCandidates,
    wantedHeaders,
    valueMarkers: options.valueMarkers ?? [],
    maxRows: options.maxRows ?? 20,
  });
}

/**
 * 列出這一頁每張表格的欄位標題（找不到目標時的排查用）。
 *
 * ⚠ 個資：只取標題列，資料列一個都不碰。欄名屬畫面結構，不是個人資料。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {number} [limit] 最多列幾張表
 * @returns {Promise<string[]>} 例如 `[項次｜上傳時間｜檔案類型]（3 列）`
 */
export async function listTableHeaders(frame, limit = 8) {
  return frame.evaluate(queryPage, { mode: 'tableHeaders', limit });
}

/**
 * 取出「含有指定字樣」的表格列，例如傳輸紀錄裡寫著「12導程」的那幾列。
 *
 * ⚠ 個資：這是本模組唯一會帶出資料格內容的函式。判斷「上傳時間在不在到院之前」
 *   非讀不可，因此防護放在**限縮範圍**：只回傳命中的那幾列、每格截斷、長數字遮蔽。
 *   呼叫端只從中取出時間字串，其餘用完即棄，不寫入任何檔案。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} markers 用來認出目標列的字樣（任一命中即可）
 * @param {{maxRows?: number, maxCellLength?: number}} [options]
 * @returns {Promise<{headers:string[], rows:string[][], scanned:number}>}
 */
export async function findMarkedRows(frame, markers, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'markedRows',
    markers,
    maxRows: options.maxRows ?? 20,
    maxCellLength: options.maxCellLength ?? 40,
  });
}

/**
 * 列出這一頁的下拉選單與各自的前幾個選項（找不到目標下拉時的排查用）。
 * ⚠ 下拉選項屬系統代碼表（分隊、狀態…），非個人資料。
 * @returns {Promise<{selector:string, nearbyText:string, optionCount:number, sampleOptions:string[]}[]>}
 */
export async function listSelects(frame, limit = 40) {
  return frame.evaluate(queryPage, { mode: 'selectList', limit });
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
 * 讀取「某個按鈕所在那一列」的指定欄位。
 *
 * ⚠ 個資：只回傳 `wantedHeaders` 命中的欄位值，其餘儲存格內容不會被帶出來；
 *   `headers`（欄位名稱）屬表格結構，可安全記錄，用來排查欄名對不上的情況。
 *
 * @param {import('playwright-core').Frame} frame
 * @param {string[]} textCandidates 用來定位那一列的按鈕文字
 * @param {number} index 第幾個符合的按鈕
 * @param {string[]} wantedHeaders 想取得的欄位名稱（以「包含」比對）
 * @param {{exact?: boolean}} [options] 必須與取得 index 時的比對方式一致
 * @returns {Promise<{headers: string[], values: Record<string,string>, columnCount: number}|null>}
 */
export async function readRowFields(frame, textCandidates, index, wantedHeaders, options = {}) {
  return frame.evaluate(queryPage, {
    mode: 'rowFields',
    texts: textCandidates,
    index,
    wantedHeaders,
    exact: options.exact ?? false,
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
