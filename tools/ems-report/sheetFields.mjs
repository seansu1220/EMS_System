/**
 * 從救護紀錄表的文字中挑出需要的兩個欄位（**純函式**，無副作用，可單獨測試）。
 *
 * ⚠ 個資原則：呼叫端只保留這裡回傳的案號與 TEMSIS，紀錄表全文用完即丟、不落檔、不進 log。
 *   log 要顯示時一律先過 `maskCode()`。
 */

/**
 * 把文字壓掉空白，同時保留「壓縮後每個字元在原文的位置」。
 *
 * 為什麼要保留位置：標籤與值之間常夾著換行與大量空白（PDF 尤其明顯），
 * 壓掉空白才找得到標籤，但取值時又必須回到原文才知道值到哪裡結束。
 *
 * @param {string} text
 * @returns {{compacted: string, indexMap: number[]}}
 */
function compactWithIndex(text) {
  const characters = [];
  const indexMap = [];
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position];
    if (/[\s　]/.test(character)) continue;
    characters.push(character.toUpperCase());
    indexMap.push(position);
  }
  return { compacted: characters.join(''), indexMap };
}

/** 值的樣式：英數字開頭，可含 -、_、/，長度至少 4（案號、TEMSIS 都遠長於此）。 */
const CODE_PATTERN = /[A-Za-z0-9][A-Za-z0-9\-_/]{3,}/;

/**
 * 找出某個標籤後面接的編號。
 *
 * 作法：先在「壓掉空白的文字」裡找標籤，再回到原文從標籤結束處往後掃，
 * 取第一段符合編號樣式的字串。
 *
 * @param {string} text 紀錄表全文
 * @param {string[]} labelCandidates 標籤文字候選（由前往後試）
 * @param {{searchWindow?: number}} [options] 標籤後往後找幾個字元
 * @returns {{value: string, label: string}|null} 找不到時回傳 null（不猜值）
 */
export function extractLabeledCode(text, labelCandidates, options = {}) {
  if (!text) return null;
  const searchWindow = options.searchWindow ?? 120;
  const { compacted, indexMap } = compactWithIndex(text);

  for (const label of labelCandidates) {
    const { compacted: compactedLabel } = compactWithIndex(label);
    if (!compactedLabel) continue;

    let searchFrom = 0;
    for (;;) {
      const hit = compacted.indexOf(compactedLabel, searchFrom);
      if (hit === -1) break;
      searchFrom = hit + 1;

      // 標籤最後一個字在原文的位置，往後就是值所在的區間。
      const labelEndInSource = indexMap[hit + compactedLabel.length - 1];
      if (labelEndInSource === undefined) continue;
      const window = text.slice(labelEndInSource + 1, labelEndInSource + 1 + searchWindow);
      const matched = CODE_PATTERN.exec(window);
      if (matched) return { value: matched[0], label };
    }
  }
  return null;
}

/**
 * 兩個編號是否視為同一筆。
 *
 * 比對前去掉空白與常見分隔符號並轉大寫：同一個 TEMSIS 在不同畫面上
 * 可能寫成 `115-070100123` 或 `115070100123`。
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function isSameCode(left, right) {
  const normalize = (value) =>
    String(value ?? '')
      .replace(/[\s　\-_/]/g, '')
      .toUpperCase();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

/**
 * 遮蔽編號，只留末 4 碼（例如 `********1234`）。
 *
 * 使用者需要看到末幾碼才能核對程式有沒有比對錯，但完整編號屬可識別個案的資料，
 * 不應出現在終端機畫面或執行紀錄檔裡。
 *
 * @param {string} code
 * @returns {string}
 */
export function maskCode(code) {
  const text = String(code ?? '');
  if (!text) return '(空白)';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`;
}
