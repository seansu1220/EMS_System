/**
 * `out/internal/解鎖前後比對/` 底下的檔案存取（v1.57.0）。
 *
 * 使用者 2026-11-03：檔案要分資料夾，不然很雜。所以每一件放在自己的資料夾
 * （`{案件年月}/{TEMSIS}/`，規則見 `revisionTrack.mjs` 的 `revisionCaseFolder`），
 * 追蹤清單記的是相對路徑。這一支負責：相對路徑 → 實際路徑、寫檔（順手建資料夾）、
 * 以及把舊版平放的檔案搬進資料夾（`organizeRevisionFiles`）。
 *
 * ⚠ 個資：這裡的檔案都含病患資料，只在 `out/internal/`；終端機只印件數。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { log } from './logger.mjs';
import { folderedRevisionPath, loadTracker, saveTracker } from './revisionTrack.mjs';

/** 追蹤清單的位置（放在 `解鎖前後比對/` 最上層）。 */
export const TRACKER_FILE = path.join(PATHS.revisionDir, '追蹤清單.json');

/** 追蹤清單裡記檔案路徑的欄位。 */
const FILE_FIELDS = ['backupFile', 'closedFile', 'reportFile'];

/**
 * 相對路徑（`/` 分隔）→ 本機的完整路徑。
 * @param {string} relativePath
 * @returns {string}
 */
export function revisionFilePath(relativePath) {
  return path.join(PATHS.revisionDir, ...relativePath.split('/'));
}

/**
 * 寫一個檔（資料夾不存在就建）。
 * @param {string} relativePath
 * @param {Buffer|string} contents
 * @throws 寫不進去時（訊息寫明是哪個檔）
 */
export async function writeRevisionFile(relativePath, contents) {
  const filePath = revisionFilePath(relativePath);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  } catch (error) {
    throw new Error(`存不進本機（${relativePath}）：${error instanceof Error ? error.message : error}`);
  }
}

/** 檔案在不在。 */
async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

/**
 * 把一個舊檔搬進資料夾。目的地已經有了就不動（上次搬到一半）。
 * @returns {Promise<boolean>} 新位置有沒有檔案（有才改追蹤清單）
 */
async function moveIntoFolder(oldName, newPath) {
  const source = revisionFilePath(oldName);
  const target = revisionFilePath(newPath);
  if (await exists(target)) return true;
  if (!(await exists(source))) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
  return true;
}

/**
 * 舊版（v1.56.0 以前）平放在 `解鎖前後比對/` 的檔案搬進各自的資料夾，並更新追蹤清單。
 *
 * 每次結案後比對、匯出解鎖修改紀錄之前呼叫；已經搬過就什麼都不做。
 * 搬不動的檔（例如正被開著）保留舊路徑，下次再搬，照樣讀得到。**絕不丟例外。**
 *
 * @returns {Promise<number>} 這次搬了幾個檔
 */
export async function organizeRevisionFiles() {
  try {
    const tracker = await loadTracker(TRACKER_FILE);
    let moved = 0;
    const entries = [];
    for (const entry of tracker.entries) {
      const patch = {};
      for (const field of FILE_FIELDS) {
        const newPath = folderedRevisionPath(entry[field], entry.temsis);
        if (!newPath) continue;
        const ok = await moveIntoFolder(entry[field], newPath).catch((error) => {
          log.warn(`有一個比對檔搬不進資料夾，下次再搬：${error instanceof Error ? error.message : error}`);
          return false;
        });
        if (ok) patch[field] = newPath;
      }
      moved += Object.keys(patch).length;
      entries.push({ ...entry, ...patch });
    }
    if (moved === 0) return 0;
    await saveTracker(TRACKER_FILE, { ...tracker, entries });
    log.info(`已把 ${moved} 個舊的比對檔整理進各案件的資料夾（out/internal/解鎖前後比對/{案件年月}/{TEMSIS}/）`);
    return moved;
  } catch (error) {
    log.warn(`整理比對檔資料夾沒有完成（不影響比對）：${error instanceof Error ? error.message : error}`);
    return 0;
  }
}
