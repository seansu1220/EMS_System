/**
 * 產出檔的保留期限：只留最近幾個月，更舊的掃到就刪。
 *
 * 使用者 2026-08-10 要求「月報至少存三個月，超過就可以刪」。
 * 不做的話 `out/report/` 會一路累積，幾個月後光是分辨「哪份才是這次的」就很花時間
 * ——先前就發生過舊檔留著被誤認成本次結果的情形（見 `ekgLists.mjs` 的舊檔處理）。
 *
 * ⚠ 保留哪幾個月是**依檔名裡最新的月份**往回算，不是依今天的日期：
 *   補跑舊月份時（`--month=2026-05`）不該把比它新的檔案掃掉。
 *
 * ⚠ 只刪**檔名結尾是 `-YYYY-MM` 的產出檔**。使用者自己放進去的檔案沒有這個樣式，
 *   不會被誤刪。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, REPORT_RETENTION_MONTHS } from './config.mjs';
import { log } from './logger.mjs';

/** 產出檔的檔名樣式：`任意名稱-YYYY-MM.副檔名`。 */
const MONTHLY_FILE_PATTERN = /-(\d{4})-(\d{2})\.(xlsx|xls|md|csv)$/i;

/**
 * 從一批檔名裡挑出「該刪的」。純函式，方便測試各種邊界。
 *
 * @param {string[]} fileNames 同一個資料夾裡的檔名（不含路徑）
 * @param {number} [keepMonths] 保留幾個月份
 * @returns {{expired: string[], keptMonths: string[]}}
 *   `expired` 是該刪的檔名；`keptMonths` 是保留下來的月份標籤（新到舊）
 */
export function selectExpiredFiles(fileNames, keepMonths = REPORT_RETENTION_MONTHS) {
  const monthOf = (fileName) => {
    const matched = MONTHLY_FILE_PATTERN.exec(fileName);
    return matched ? `${matched[1]}-${matched[2]}` : null;
  };

  const months = [...new Set(fileNames.map(monthOf).filter(Boolean))].sort().reverse();
  const keptMonths = months.slice(0, Math.max(0, keepMonths));
  const kept = new Set(keptMonths);

  return {
    keptMonths,
    // 認不出月份的檔案一律不動——那不是我們產的。
    expired: fileNames.filter((fileName) => {
      const month = monthOf(fileName);
      return month !== null && !kept.has(month);
    }),
  };
}

/** 掃一個資料夾並刪掉過期檔；回傳刪掉的檔名。 */
async function pruneDirectory(directory, keepMonths) {
  const fileNames = await fs.readdir(directory).catch(() => null);
  if (fileNames === null) return []; // 資料夾還不存在屬正常（第一次跑）。

  const { expired } = selectExpiredFiles(fileNames, keepMonths);
  const removed = [];
  for (const fileName of expired) {
    try {
      await fs.rm(path.join(directory, fileName), { force: true });
      removed.push(fileName);
    } catch (error) {
      // 刪不掉（多半是被 Excel 開著）不該讓整個流程失敗——報表都已經產好了。
      log.warn(`舊檔 ${fileName} 刪不掉（${error instanceof Error ? error.message : String(error)}），略過。`);
    }
  }
  return removed;
}

/**
 * 清掉 `out/report/` 與 `out/internal/` 裡過期的月份產出。
 *
 * @param {number} [keepMonths]
 * @returns {Promise<string[]>} 刪掉的檔名
 */
export async function pruneOldOutputs(keepMonths = REPORT_RETENTION_MONTHS) {
  const removed = [];
  for (const directory of [PATHS.reportDir, PATHS.internalDir]) {
    removed.push(...await pruneDirectory(directory, keepMonths));
  }

  if (removed.length === 0) return removed;
  log.step('清掉過期的舊月份產出');
  log.info(`只保留最近 ${keepMonths} 個月，已刪 ${removed.length} 個檔案：`);
  for (const fileName of removed) log.info(`　${fileName}`);
  return removed;
}
