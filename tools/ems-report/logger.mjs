/**
 * 終端機輸出與敏感資訊遮蔽。
 *
 * ⚠ 個資原則：本工具的 log 只描述「流程進行到哪」與「數量」，
 *   絕不輸出個案明細（姓名、身分證、地址、電話、病歷內容等）。
 */

/** 遮蔽帳號，只保留頭尾各一碼，例如 `a****9`。 */
export function maskAccount(account) {
  if (!account) return '(未設定)';
  const text = String(account);
  if (text.length <= 2) return '*'.repeat(text.length);
  return `${text[0]}${'*'.repeat(text.length - 2)}${text[text.length - 1]}`;
}

/**
 * 執行紀錄。所有輸出都會同時留一份在記憶體，結束時寫成檔案，
 * 這樣失敗時不必請使用者逐字抄寫終端機訊息。
 *
 * ⚠ 個資原則：log 內容依設計只有流程與筆數，不含個案明細，因此可安全落檔。
 */
const logLines = [];

/** 記錄一行並輸出到終端機。 */
function record(text, toStderr = false) {
  logLines.push(`[${new Date().toISOString()}] ${text}`);
  if (toStderr) console.error(text);
  else console.log(text);
}

export const log = {
  step(message) {
    record(`\n▶ ${message}`);
  },
  info(message) {
    record(`  ${message}`);
  },
  ok(message) {
    record(`  ✅ ${message}`);
  },
  warn(message) {
    record(`  ⚠ ${message}`, true);
  },
  /**
   * 錯誤輸出：一定說明「發生在哪個步驟」與「原因」，不靜默吞掉。
   * @param {string} stage 發生階段
   * @param {unknown} error
   */
  fail(stage, error) {
    const reason = error instanceof Error ? error.message : String(error);
    record(`\n❌ [${stage}] 失敗：${reason}`, true);
    if (error instanceof Error && error.stack) {
      logLines.push(error.stack);
    }
  },
};

/**
 * 把執行紀錄寫成檔案。
 * @param {string} filePath
 * @returns {Promise<void>}
 */
export async function writeLogFile(filePath) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, logLines.join('\n'), 'utf8');
}

/** 共用的 readline 介面，第一次用到才建立。 */
let readlineInterface = null;

/** 輸入串流是否已結束（EOF），例如被導向檔案或使用者按了 Ctrl+Z。 */
let inputClosed = false;

/**
 * 尚未被 prompt() 取用的輸入行。
 *
 * `null`＝不緩衝（預設）；陣列＝緩衝中，見 {@link startLineBuffering}。
 * @type {string[]|null}
 */
let bufferedLines = null;

/** 建立（或取回）共用的 readline 介面。 */
async function ensureInterface() {
  if (readlineInterface) return readlineInterface;
  const { createInterface } = await import('node:readline/promises');
  readlineInterface = createInterface({ input: process.stdin, output: process.stdout });
  readlineInterface.on('close', () => {
    inputClosed = true;
  });
  // 沒有 question() 在等待時，readline 照樣會把輸入讀走並發出 line 事件；
  // 不接住的話，「一次貼上多行」只有第一行收得到，其餘會憑空消失。
  readlineInterface.on('line', (line) => {
    bufferedLines?.push(line);
  });
  return readlineInterface;
}

/**
 * 開始緩衝輸入行，讓使用者可以「一次貼上多行」而不漏行。
 *
 * 只在連續讀取多行的情境開啟（例如貼上 TEMSIS 清單）；其餘等待單一按鍵的場合
 * 維持不緩衝，避免使用者在等待登入時誤按的 Enter 被留到後面才生效。
 * 用完務必呼叫 {@link stopLineBuffering}（建議放在 finally）。
 */
export async function startLineBuffering() {
  bufferedLines = [];
  await ensureInterface();
}

/** 停止緩衝，並丟棄尚未取用的行。 */
export function stopLineBuffering() {
  bufferedLines = null;
}

/**
 * 在終端機等待使用者輸入一行（直接按 Enter 則回傳空字串）。
 *
 * 用 readline 而非直接監聽 stdin：本工具透過 .bat → npm → node 多層轉手執行，
 * readline 對這種情況的相容性較好，不會出現按了鍵卻沒反應的情形。
 *
 * @param {string} question 提示文字
 * @returns {Promise<string|null>} 使用者輸入；**輸入串流已結束時回傳 `null`**
 *   （呼叫端須視為「結束」，不可當成空字串繼續迴圈，否則會無限循環）
 */
export async function prompt(question) {
  await ensureInterface();
  // 先消化緩衝：輸入串流已經結束（例如整段一次灌進來）時，
  // 緩衝裡往往還有沒處理完的行，不先取用就會被當成「沒輸入」。
  if (bufferedLines?.length) {
    const buffered = bufferedLines.shift();
    // 貼上的內容雖已由終端機回顯，仍補印一次，讓畫面上「第幾筆＝哪個號碼」對得起來。
    process.stdout.write(`${question}${buffered}\n`);
    return buffered.trim();
  }
  if (inputClosed) return null;
  // readline 關閉時，等待中的 question() 永遠不會 resolve，故一併競賽 close 事件。
  const closed = new Promise((resolve) => readlineInterface.once('close', () => resolve(null)));
  const answer = await Promise.race([readlineInterface.question(question), closed]);
  return answer === null ? null : answer.trim();
}

/** 關閉 readline，讓程式能正常結束。 */
export function closePrompt() {
  readlineInterface?.close();
  readlineInterface = null;
  inputClosed = false;
  bufferedLines = null;
}
