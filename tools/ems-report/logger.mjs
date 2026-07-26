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

export const log = {
  step(message) {
    console.log(`\n▶ ${message}`);
  },
  info(message) {
    console.log(`  ${message}`);
  },
  ok(message) {
    console.log(`  ✅ ${message}`);
  },
  warn(message) {
    console.warn(`  ⚠ ${message}`);
  },
  /**
   * 錯誤輸出：一定說明「發生在哪個步驟」與「原因」，不靜默吞掉。
   * @param {string} stage 發生階段
   * @param {unknown} error
   */
  fail(stage, error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ [${stage}] 失敗：${reason}`);
  },
};

/** 在終端機等待使用者按 Enter（或輸入文字）。 */
export function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const onData = (chunk) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(String(chunk).trim());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
