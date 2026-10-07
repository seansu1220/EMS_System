/**
 * 把一個月的產出**收進一個資料夾**，方便整包拿走。
 *
 * 使用者 2026-10-07 要求：「月報表做完後，可否直接生成一個資料夾把它包起來，
 * 因為這個東西生成的檔案比較多。」確實——一次月報表會產出 7、8 個檔案，
 * 散在 `out/report/` 與 `out/internal/` 兩個資料夾裡，還跟前幾個月的混在一起。
 *
 * ## ⚠ 包起來**不可以把兩種檔案混成一堆**
 *
 * `out/report/` 的東西是**會發給各分隊的**；`out/internal/` 的東西含全局逐案判定，
 * **不能給分隊看**（見 0.3 與 `PATHS.internalDir` 的說明）。
 * 圖個方便把它們倒進同一個資料夾，遲早有人把整包寄出去。
 * 因此包裝後仍分成兩個子資料夾，名字就直接寫清楚能不能外發。
 *
 * ## ⚠ 人工判定清單**刻意不複製**
 *
 * 那一份是要使用者填完、下次跑再讀回去的（見 3.16）。複製一份進來，
 * 使用者十之八九會填副本——而程式只讀 `out/internal/` 的正本，
 * 於是「填了卻沒生效」，而且畫面上完全看不出來。
 * 所以這裡只在說明檔裡指路，不放副本。
 *
 * ## 用複製，不用搬移
 *
 * 搬走的話，續跑要用的進度檔與人工判定清單都不見了，
 * 下個月重跑同一個月份就得從頭跑一兩個小時。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { monthOfOutputFile } from './fileNames.mjs';
import { log } from './logger.mjs';

/** 包裝資料夾的名稱（月份在前，與產出檔同一套規則，`retention.mjs` 才認得）。 */
export const bundleFolderName = (monthRange) => `${monthRange.label}-月報表`;

/** 兩個子資料夾的名字就是它們的使用規則，不另外取代號。 */
const SUBFOLDERS = {
  report: '可發給分隊',
  internal: '內部用-不要外發',
};

/**
 * 不收進包裝資料夾的檔案。
 *
 * - **人工判定清單**：要填正本，不能有副本（見檔頭說明）
 * - **查核進度檔**：程式續跑用的中間產物，不是給人看的東西
 * - **操作備忘**：每次都會複製到 `out/report/`，不屬於某一個月份
 */
const EXCLUDED_PREFIXES = ['心電圖-人工判定', '心電圖查核進度'];

/** 這個檔名是不是「這個月份、而且該收進包裝」的產出。 */
export function shouldBundle(fileName, monthLabel, excluded = EXCLUDED_PREFIXES) {
  if (monthOfOutputFile(fileName) !== monthLabel) return false;
  return !excluded.some((prefix) => fileName.includes(prefix));
}

/**
 * 組出說明檔的內容（純函式，方便測試）。
 *
 * 寫給人看，因此**先講哪些不能外發**，再講要去哪裡填判定——
 * 這兩件是打開資料夾的人最需要先知道的。
 *
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @param {{report: string[], internal: string[]}} copied 各子資料夾收了哪些檔案
 * @returns {string}
 */
export function buildReadme(monthRange, copied) {
  const reviewFileName = `${monthRange.label}-心電圖-人工判定.xlsx`;
  return [
    `${monthRange.label} 月度報表`,
    '',
    `產出時間：${new Date().toLocaleString('zh-TW', { hour12: false })}`,
    '',
    '────────────────────────────────────────',
    '這個資料夾裡有兩個子資料夾，請務必分清楚：',
    '',
    `【${SUBFOLDERS.report}】`,
    '  只有分隊層級的統計數字，可以直接發出去。',
    ...copied.report.map((name) => `    ・${name}`),
    '',
    `【${SUBFOLDERS.internal}】`,
    '  含全局每一件案子的判定與依據，**不要發給分隊**。',
    ...copied.internal.map((name) => `    ・${name}`),
    '',
    '────────────────────────────────────────',
    '還有一份東西**刻意沒有放進來**：',
    '',
    `  ${reviewFileName}`,
    '',
    '  那是「程式判不出來、要你看完填回去」的清單。',
    '  它必須留在原處，程式下次跑才讀得到：',
    '',
    `    tools\\ems-report\\out\\internal\\${reviewFileName}`,
    '',
    '  填法：點開檔案裡的「檔案連結」欄看原始檔案，',
    '  在「你的判定」欄填「算」或「不算」，存檔，',
    '  然後再跑一次「月度報表輸出.bat」、月份輸入同一個月。',
    '  程式會照你的判定重算，產出最終版本的數字。',
    '',
    '  （如果把判定填在這個資料夾裡的副本上，程式讀不到，等於沒填。',
    '   所以這裡不放副本。）',
    '',
    '────────────────────────────────────────',
    '這一包是從 out/report/ 與 out/internal/ 複製出來的，',
    '原檔都還在原處，照樣保留三個月。',
    '',
  ].join('\r\n');
}

/**
 * 把這個月的產出複製進包裝資料夾。
 *
 * **失敗不往外拋**：報表都已經產好了，包裝只是方便拿，
 * 不該因為一個複製失敗就讓整次執行被判定為失敗。
 *
 * @param {import('./dateRange.mjs').MonthRange} monthRange
 * @returns {Promise<{folder: string, report: string[], internal: string[]}|null>}
 *   一個檔案都沒收到時回傳 null（例如兩份報表都失敗）
 */
export async function bundleMonthlyOutputs(monthRange) {
  const folder = path.join(PATHS.outDir, bundleFolderName(monthRange));
  const sources = [
    { from: PATHS.reportDir, into: SUBFOLDERS.report, key: 'report' },
    { from: PATHS.internalDir, into: SUBFOLDERS.internal, key: 'internal' },
  ];
  const copied = { report: [], internal: [] };

  for (const source of sources) {
    const fileNames = await fs.readdir(source.from).catch(() => null);
    if (fileNames === null) continue; // 那個資料夾還不存在，正常。
    const wanted = fileNames.filter((fileName) => shouldBundle(fileName, monthRange.label));
    if (wanted.length === 0) continue;

    const target = path.join(folder, source.into);
    await fs.mkdir(target, { recursive: true });
    for (const fileName of wanted) {
      try {
        await fs.copyFile(path.join(source.from, fileName), path.join(target, fileName));
        copied[source.key].push(fileName);
      } catch (error) {
        log.warn(`${fileName} 複製進月報表資料夾時失敗（原檔還在原處）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (copied.report.length === 0 && copied.internal.length === 0) {
    log.warn('這次沒有可以收進月報表資料夾的檔案（兩份報表可能都沒產出）。');
    return null;
  }

  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '請先看我.txt'), buildReadme(monthRange, copied), 'utf8')
    .catch((error) => {
      log.warn(`說明檔寫不出來（不影響已複製的報表）：${error instanceof Error ? error.message : String(error)}`);
    });

  log.step('這個月的產出已經收進一個資料夾');
  log.ok(`　${path.relative(process.cwd(), folder)}`);
  log.info(`　├ ${SUBFOLDERS.report}：${copied.report.length} 個檔案（可以直接發出去）`);
  log.info(`　└ ${SUBFOLDERS.internal}：${copied.internal.length} 個檔案（**不要發給分隊**）`);
  log.info('　資料夾裡的「請先看我.txt」寫了哪些能發、以及要去哪裡填人工判定。');
  return { folder, ...copied };
}
