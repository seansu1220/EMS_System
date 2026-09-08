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
 * ⚠ 只刪**認得出來的產出檔**（見 `fileNames.mjs` 的 `monthOfOutputFile`）。
 *   2026-09-05 起年月改放在檔名最前面，而「2026-08-分隊回覆.xlsx」正是使用者
 *   自己也會取的名字，因此新寫法**要對得上產出檔名單**才算數；舊寫法（年月在後）
 *   照樣認得，資料夾裡先前產的檔案才清得掉。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, REPORT_RETENTION_MONTHS } from './config.mjs';
import {
  MONTHLY_OUTPUT_NAMES,
  legacyMonthlyFileName,
  monthlyFileName,
  monthOfOutputFile,
} from './fileNames.mjs';
import { log } from './logger.mjs';

/**
 * 從一批檔名裡挑出「該刪的」。純函式，方便測試各種邊界。
 *
 * @param {string[]} fileNames 同一個資料夾裡的檔名（不含路徑）
 * @param {number} [keepMonths] 保留幾個月份
 * @returns {{expired: string[], keptMonths: string[]}}
 *   `expired` 是該刪的檔名；`keptMonths` 是保留下來的月份標籤（新到舊）
 */
export function selectExpiredFiles(fileNames, keepMonths = REPORT_RETENTION_MONTHS) {
  const months = [...new Set(fileNames.map(monthOfOutputFile).filter(Boolean))].sort().reverse();
  const keptMonths = months.slice(0, Math.max(0, keepMonths));
  const kept = new Set(keptMonths);

  return {
    keptMonths,
    // 認不出月份的檔案一律不動——那不是我們產的。
    expired: fileNames.filter((fileName) => {
      const month = monthOfOutputFile(fileName);
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

/**
 * 重跑一個**以前跑過的月份**時，把舊檔名（年月在後）那幾份刪掉。
 *
 * 2026-09-05 把年月改到檔名最前面。不刪舊的話，同一個月會躺著兩份名字不同、
 * 內容也不同的報表（舊那份是上次跑的結果），遲早有人拿錯。
 *
 * ⚠ **只有新檔確實產出來了才刪舊的**。流程中途失敗、這次什麼都沒寫出來時，
 *   刪掉舊檔會讓使用者連上次的結果都沒有。
 *
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<string[]>} 刪掉的檔名
 */
export async function removeLegacyTwins(monthRange) {
  const removed = [];
  for (const directory of [PATHS.reportDir, PATHS.internalDir]) {
    const fileNames = await fs.readdir(directory).catch(() => null);
    if (fileNames === null) continue;
    const present = new Set(fileNames);
    for (const name of MONTHLY_OUTPUT_NAMES) {
      for (const extension of ['xlsx', 'md']) {
        const legacy = legacyMonthlyFileName(monthRange, name, extension);
        const current = monthlyFileName(monthRange, name, extension);
        if (!present.has(legacy) || !present.has(current)) continue;
        try {
          await fs.rm(path.join(directory, legacy), { force: true });
          removed.push(legacy);
        } catch (error) {
          log.warn(`舊檔名的 ${legacy} 刪不掉（${error instanceof Error ? error.message : String(error)}），略過。`);
        }
      }
    }
  }
  if (removed.length === 0) return removed;
  log.step('清掉舊檔名的同月產出');
  log.info('年月已改放在檔名最前面，同一個月的舊檔名版本刪掉，免得拿錯：');
  for (const fileName of removed) log.info(`　${fileName}`);
  return removed;
}
