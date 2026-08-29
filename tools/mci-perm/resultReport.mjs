/**
 * 執行結果的彙整與落檔。
 *
 * ⚠ 個資原則：結果清單含姓名，因此
 *   - 只寫到本工具的 `out/result/`（`.gitignore` 已排除 `tools/**\/out/`），不上雲、不進版控
 *   - 終端機與 `last-run.log` 只印遮蔽後的姓名（`王○○`）
 *   - 超過保留天數的舊檔在每次執行時自動刪除
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, RESULT_RETENTION_DAYS } from './config.mjs';
import { SETTLED_OUTCOMES } from './grantFlow.mjs';
import { log, maskName } from './logger.mjs';
import { describeRosterLocation } from './roster.mjs';

/**
 * @typedef {Object} Summary
 * @property {number} total
 * @property {Record<string, number>} byOutcome 各結果各有幾筆
 * @property {import('./grantFlow.mjs').GrantResult[]} needsAttention 要人工接手的
 */

/**
 * 統計各種結果各有幾筆（純函式，方便測試）。
 * @param {import('./grantFlow.mjs').GrantResult[]} results
 * @returns {Summary}
 */
export function summarize(results) {
  /** @type {Record<string, number>} */
  const byOutcome = {};
  for (const result of results) {
    byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1;
  }
  // 「本來就有了」「本來就沒有」也算做完——那是好消息，不是待辦。
  // 直接用 grantFlow 的那一份清單，開通與取消才不會各有一套「算不算做完」的定義
  //（少列一種結果，就會有一整批人被誤報成「需要你接手」）。
  const needsAttention = results.filter((result) => !SETTLED_OUTCOMES.includes(result.outcome));
  return { total: results.length, byOutcome, needsAttention };
}

/** 在終端機印出摘要（姓名一律遮蔽）。 */
export function printSummary(results) {
  const summary = summarize(results);
  log.step(`處理完畢，共 ${summary.total} 位`);
  for (const [outcome, count] of Object.entries(summary.byOutcome)) {
    log.info(`${outcome}：${count} 位`);
  }
  if (summary.needsAttention.length === 0) {
    log.ok('沒有需要你接手的');
    return summary;
  }
  log.warn(`以下 ${summary.needsAttention.length} 位需要你自己到系統確認：`);
  for (const result of summary.needsAttention) {
    // 帳號照原樣印（系統本來就遮過了）：姓名遮起來之後，那是你回系統時唯一找得到人的線索。
    const account = result.account ? `（帳號 ${result.account}）` : '';
    log.warn(`  ${result.unit}　${maskName(result.name)}${account}｜${result.outcome}｜${result.detail}`);
  }
  return summary;
}

/** 檔名用的時間戳（本地時間，看得懂比較重要）。 */
function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * 把結果寫成一份 Markdown 清單。
 *
 * ⚠ 這份檔案**含未遮蔽的姓名**（要拿來對名單、補做的人得看得懂是誰），
 *   因此只落在 `out/result/`，不可外流、不可上傳。
 *
 * @param {import('./grantFlow.mjs').GrantResult[]} results
 * @param {{execute?: boolean, now?: Date, action?: string,
 *   problems?: import('./roster.mjs').RosterProblem[],
 *   unitProblems?: import('./unitSweep.mjs').UnitProblem[]}} [options]
 *   `unitProblems`＝全面取消時「這個單位沒掃出來」的清單
 * @returns {Promise<string>} 產出的檔案路徑
 */
export async function writeResultReport(results, options = {}) {
  const summary = summarize(results);
  const now = options.now ?? new Date();
  const lines = [
    `# 大量傷患系統權限${options.action === '取消' ? '取消' : '開通'}結果`,
    ``,
    `- 執行時間：${now.toLocaleString('zh-TW')}`,
    `- 模式：${options.execute ? '正式執行（有按確定）' : '試跑（沒有按確定，系統沒有被改動）'}`,
    `- 總計：${summary.total} 位`,
    ...Object.entries(summary.byOutcome).map(([outcome, count]) => `- ${outcome}：${count} 位`),
    ``,
    `> ⚠ 本檔含姓名，屬個人資料：只供承辦人核對與補做，請勿外傳，也不要放進版控或雲端。`,
    ``,
    `| # | 單位 | 姓名 | 帳號 | 結果 | 說明 |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...results.map(
      (result, index) =>
        `| ${index + 1} | ${result.unit} | ${result.name} | ${result.account ?? ''} | ` +
        `${result.outcome} | ${result.detail} |`,
    ),
  ];

  const problems = options.problems ?? [];
  if (problems.length > 0) {
    lines.push(
      ``,
      `## 名單裡跳過的 ${problems.length} 列`,
      ``,
      `這幾列缺欄位，程式沒有處理。要補做的話，先在 Excel 裡補齊再跑一次。`,
      ``,
      ...problems.map((problem) => `- ${describeRosterLocation(problem)}：${problem.reason}`),
    );
  }

  const unitProblems = options.unitProblems ?? [];
  if (unitProblems.length > 0) {
    lines.push(
      ``,
      `## 沒掃乾淨的 ${unitProblems.length} 個單位`,
      ``,
      `這幾個單位的人**沒有全部列進上面的名單**，因此也沒有全部處理到。`,
      `請自己到系統確認，或排除原因之後再跑一次（會接續處理，已做完的不會重做）。`,
      ``,
      ...unitProblems.map((problem) => `- ${problem.unit}：${problem.reason}`),
    );
  }

  if (summary.needsAttention.length > 0) {
    lines.push(
      ``,
      `## 需要人工接手的`,
      ``,
      ...summary.needsAttention.map(
        (result) =>
          `- ${result.unit}　${result.name}${result.account ? `（帳號 ${result.account}）` : ''}：` +
          `${result.outcome}（卡在${result.step}）— ${result.detail}`,
      ),
    );
  }

  await fs.mkdir(PATHS.resultDir, { recursive: true });
  const filePath = path.join(
    PATHS.resultDir,
    `${options.action === '取消' ? '取消結果' : '開通結果'}-${timestamp(now)}.md`,
  );
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/**
 * 刪掉超過保留天數的舊結果檔。
 *
 * 留著遲早被誤認成這次的結果，而且那是一份含姓名的清單——
 * 沒有留在硬碟上的必要。
 *
 * @param {number} [days]
 * @returns {Promise<number>} 刪掉幾個檔
 */
export async function pruneOldResults(days = RESULT_RETENTION_DAYS) {
  let entries;
  try {
    entries = await fs.readdir(PATHS.resultDir);
  } catch {
    return 0; // 還沒有這個資料夾＝第一次跑，正常。
  }
  const deadline = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    const filePath = path.join(PATHS.resultDir, entry);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < deadline) {
        await fs.rm(filePath, { force: true });
        removed += 1;
      }
    } catch {
      // 刪不掉（檔案開著、權限不足）不該讓整個流程失敗。
    }
  }
  if (removed > 0) log.info(`已清掉 ${removed} 份超過 ${days} 天的舊結果檔`);
  return removed;
}
