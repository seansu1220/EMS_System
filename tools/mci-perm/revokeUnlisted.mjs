/**
 * 「取消名單外的 DACPR 權限」：全部名單有、保留名單沒有的人，取消 DQC DA-CPR 品管系統的勾選。
 *
 * 使用者 2026-10-17 的要求：「比對兩份資料，找出 A 份資料沒有的名單，
 * 登入一站通之後把那個人的 DACPR 系統權限關掉」。
 *   - 保留名單（A 份）：從圖片抄成文字，只有單位與姓名，檔名以「保留名單」開頭
 *   - 全部名單：Excel（裡面可能有身分證字號，但程式**只讀單位與姓名兩欄**）
 *
 * 流程刻意分兩段，**先比對完、印出來，才登入動手**：
 *   1. 讀兩份名單 → 比對 → 印出「要取消幾位、存疑幾位、保留名單找不到幾位」
 *      （完整清單寫進 out/result，含姓名，只留在本機）
 *   2. 正式執行才問 yes/no，逐位只取消 DQC，其他子系統一律不碰
 *
 * ⚠ 個資原則：終端機與 log 上的姓名一律經 maskName 遮蔽；
 *   兩份名單放在 `REVOKE_UNLISTED.listDir`（已在 .gitignore 排除）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, REVOKE_UNLISTED } from './config.mjs';
import { log, maskName, prompt } from './logger.mjs';
import { clearCodesAll, displayNameOf, resolveClearCodes } from './otherSubsystems.mjs';
import { appendProgress, countByOutcome, loadProgress, splitByProgress, sweepProgressFile } from './progress.mjs';
import { printSummary, pruneOldResults, timestamp, writeResultReport } from './resultReport.mjs';
import { describeRosterLocation, readRosterFiles } from './roster.mjs';
import { diffRosters } from './rosterDiff.mjs';
import { ensureSignedIn, startSession } from './session.mjs';

/** 認得出來的名單檔副檔名（與 roster.mjs 一致）。 */
const LIST_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.csv', '.txt'];

/** 終端機上每一類最多先列幾位（完整的寫進比對結果檔）。 */
const PREVIEW_LIMIT = 20;

/**
 * 把資料夾裡的名單檔分成「保留名單」與「全部名單」。
 *
 * 純函式（只看檔名），有測試守著。`~$` 開頭的是 Excel 開著時的鎖定檔，不是名單。
 *
 * @param {string[]} fileNames 資料夾裡的檔名
 * @param {string} keepPrefix 保留名單的檔名開頭
 * @returns {{keepFiles: string[], allFiles: string[]}} 檔名（不含路徑）
 */
export function splitListFiles(fileNames, keepPrefix) {
  const lists = (fileNames ?? []).filter(
    (name) => !name.startsWith('~$') && LIST_EXTENSIONS.includes(path.extname(name).toLowerCase()),
  );
  return {
    keepFiles: lists.filter((name) => name.startsWith(keepPrefix)),
    allFiles: lists.filter((name) => !name.startsWith(keepPrefix)),
  };
}

/**
 * 決定這次用哪幾個檔：命令列有給（`--keep=`／`--file=`）就用給的，否則到名單資料夾找。
 *
 * @param {{keep: string[], files: string[]}} options
 * @returns {Promise<{keepFiles: string[], allFiles: string[]}>} 完整路徑
 */
async function resolveListFiles(options) {
  const dir = REVOKE_UNLISTED.listDir;
  let found = { keepFiles: [], allFiles: [] };
  if (options.keep.length === 0 || options.files.length === 0) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`讀不到名單資料夾 ${dir}：${reason}（請先建立這個資料夾，把兩份名單放進去）`);
    }
    const split = splitListFiles(names, REVOKE_UNLISTED.keepFilePrefix);
    found = {
      keepFiles: split.keepFiles.map((name) => path.join(dir, name)),
      allFiles: split.allFiles.map((name) => path.join(dir, name)),
    };
  }
  const keepFiles = options.keep.length > 0 ? options.keep : found.keepFiles;
  const allFiles = options.files.length > 0 ? options.files : found.allFiles;
  if (keepFiles.length === 0) {
    throw new Error(`找不到保留名單：請在 ${dir} 放一個檔名以「${REVOKE_UNLISTED.keepFilePrefix}」開頭的檔案`);
  }
  if (allFiles.length === 0) {
    throw new Error(`找不到全部名單：請把 Excel 放進 ${dir}（檔名不要以「${REVOKE_UNLISTED.keepFilePrefix}」開頭）`);
  }
  return { keepFiles, allFiles };
}

/**
 * 讀一組名單檔，並把讀不懂的列講出來。
 *
 * @param {string[]} files
 * @param {string} label 「保留名單」／「全部名單」
 */
async function readList(files, label) {
  for (const file of files) log.info(`${label}：${path.basename(file)}`);
  const result = await readRosterFiles(files, {});
  log.ok(`${label}共 ${result.entries.length} 位${result.duplicateCount > 0 ? `（${result.duplicateCount} 筆重複已併掉）` : ''}`);
  if (result.problems.length > 0) {
    log.warn(`${label}有 ${result.problems.length} 列讀不懂（會跳過）：`);
    for (const problem of result.problems.slice(0, PREVIEW_LIMIT)) {
      log.warn(`  ${describeRosterLocation(problem)}：${problem.reason}`);
    }
  }
  if (result.entries.length === 0) throw new Error(`${label}裡一個人都沒讀到，請確認檔案內容（標題列要有「姓名」與「單位」）`);
  return result;
}

/** 在終端機列出一類人（姓名遮蔽，最多 PREVIEW_LIMIT 位）。 */
function previewPeople(title, lines) {
  if (lines.length === 0) return;
  log.warn(`${title}：${lines.length} 位`);
  for (const line of lines.slice(0, PREVIEW_LIMIT)) log.warn(`  ${line}`);
  if (lines.length > PREVIEW_LIMIT) log.info(`  …其餘 ${lines.length - PREVIEW_LIMIT} 位寫在比對結果檔裡`);
}

/**
 * 把比對結果講給人聽（終端機只顯示遮蔽後的姓名）。
 *
 * @param {import('./rosterDiff.mjs').RosterDiff} diff
 */
function reportDiff(diff) {
  log.step('比對結果');
  log.ok(`在保留名單上（不動）：${diff.kept.length} 位`);
  log.ok(`不在保留名單上（要取消 DACPR）：${diff.toRevoke.length} 位`);
  previewPeople(
    '同名但單位對不上（這次不動，請人工確認）',
    diff.unitConflicts.map(({ entry, keepUnits }) => `${entry.unit}　${maskName(entry.name)}（保留名單寫的是 ${keepUnits.join('、')}）`),
  );
  previewPeople(
    '姓名只差一個字，疑似抄錯（這次不動，請人工確認）',
    diff.typoSuspects.map(({ entry }) => `${entry.unit}　${maskName(entry.name)}`),
  );
  previewPeople(
    '保留名單上有、全部名單裡找不到',
    diff.keepUnmatched.map((entry) => `${entry.unit}　${maskName(entry.name)}`),
  );
}

/**
 * 把完整比對結果寫成檔案（含完整姓名，只留在本機的 out/result，30 天後自動刪）。
 *
 * @param {import('./rosterDiff.mjs').RosterDiff} diff
 * @param {{keepFiles: string[], allFiles: string[]}} files
 * @returns {Promise<string>}
 */
async function writeDiffReport(diff, files) {
  const row = (entry) => `- ${entry.unit}　${entry.name}`;
  const section = (title, note, items) =>
    items.length === 0 ? [] : ['', `## ${title}（${items.length} 位）`, '', note, '', ...items];
  const lines = [
    '# DACPR 權限名單比對結果',
    '',
    `- 比對時間：${new Date().toLocaleString('zh-TW')}`,
    `- 保留名單：${files.keepFiles.map((file) => path.basename(file)).join('、')}`,
    `- 全部名單：${files.allFiles.map((file) => path.basename(file)).join('、')}`,
    `- 在保留名單上：${diff.kept.length} 位；要取消：${diff.toRevoke.length} 位`,
    '',
    '> ⚠ 本檔含姓名，屬個人資料：只供承辦人核對，請勿外傳，也不要放進版控或雲端。',
    ...section('要取消 DACPR 的人', '全部名單有、保留名單沒有同名者。', diff.toRevoke.map(row)),
    ...section(
      '同名但單位對不上（不動）',
      '兩份名單都有這個姓名，但單位寫法對不起來。是同一個人就不必處理；不是的話請自己到系統取消。',
      diff.unitConflicts.map(({ entry, keepUnits }) => `${row(entry)}（保留名單寫的是 ${keepUnits.join('、')}）`),
    ),
    ...section(
      '疑似抄錯字（不動）',
      '全部名單的這位，跟保留名單某位只差一個字、單位相同，多半是抄寫時看錯字。',
      diff.typoSuspects.map(({ entry, keepEntry }) => `${row(entry)}（保留名單寫成「${keepEntry.name}」）`),
    ),
    ...section(
      '保留名單上有、全部名單找不到',
      '可能是保留名單抄錯字，或這位本來就不在全部名單裡。請核對一下。',
      diff.keepUnmatched.map(row),
    ),
  ];
  await fs.mkdir(PATHS.resultDir, { recursive: true });
  const filePath = path.join(PATHS.resultDir, `DACPR名單比對-${timestamp()}.md`);
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/**
 * 讀兩份名單並比對；比對結果明顯不對勁時停手。
 *
 * @returns {Promise<{diff: import('./rosterDiff.mjs').RosterDiff, problems: object[],
 *   files: {keepFiles: string[], allFiles: string[]}}>}
 */
async function compareLists(options) {
  const files = await resolveListFiles(options);
  const keep = await readList(files.keepFiles, '保留名單');
  const all = await readList(files.allFiles, '全部名單');
  const diff = diffRosters(all.entries, keep.entries);
  reportDiff(diff);
  const reportPath = await writeDiffReport(diff, files);
  log.ok(`完整比對結果：${reportPath}（含姓名，請勿外傳）`);

  // ⚠ 一個人都對不上＝多半放錯檔案（或欄位讀反了）。這時候照跑，等於把全部名單的人通通取消。
  if (diff.kept.length === 0) {
    throw new Error('兩份名單一個人都對不上，多半是放錯檔案或欄位讀錯了，為了不誤取消所有人，這次停手不做');
  }
  return { diff, problems: [...keep.problems, ...all.problems], files };
}

/**
 * 正式執行前問一次（`--yes` 時不問）。
 *
 * @returns {Promise<boolean>}
 */
async function confirmRevoke(count, codeName, options) {
  log.warn(`即將檢查 ${count} 位，有勾「${codeName}」的取消勾選，這會真的寫進系統。`);
  log.info('其他子系統（MCI、ACS 等）一律不會被動到；本來就沒勾的人直接跳過。');
  if (options.yes) {
    log.info('依 --yes 不再詢問，直接開始。');
    return true;
  }
  const answer = await prompt('  yes/no: ');
  const agreed = ['y', 'yes'].includes(String(answer ?? '').toLowerCase());
  if (!agreed) log.info('已取消，系統沒有被改動。');
  return agreed;
}

/**
 * 進度檔的名字：依**全部名單的檔名**分開記。
 *
 * 只用固定名字的話，下個月換一份新名單來跑，上次做過的人會被當成「已處理」而跳過
 * （那時他可能又被開回權限了）。換了檔案就是另一份進度。
 *
 * @param {string[]} allFiles
 * @returns {string}
 */
export function progressLabel(allFiles) {
  const first = path.basename(allFiles[0] ?? '', path.extname(allFiles[0] ?? '')).replace(/[\\/:*?"<>|]/g, '_');
  const more = allFiles.length > 1 ? `等${allFiles.length}份` : '';
  return `${REVOKE_UNLISTED.label}-${first.slice(0, 40)}${more}`;
}

/**
 * 依進度與 `--limit` 決定這次實際要做的人。
 *
 * @returns {Promise<import('./roster.mjs').RosterEntry[]>}
 */
async function pickWork(entries, progressFile, options) {
  if (options.restart) {
    await fs.rm(progressFile, { force: true }).catch(() => {});
    log.info('依 --restart 捨棄上次的進度，這次整份從頭跑');
  }
  const progress = await loadProgress(progressFile);
  const { todo, skipped } = splitByProgress(entries, progress);
  if (skipped.length > 0) {
    const counts = countByOutcome(progress);
    log.step(`接續上次的進度：已處理 ${skipped.length} 位，這次要做 ${todo.length} 位`);
    log.info(`（上次的結果：${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join('、')}）`);
  }
  if (options.limit > 0 && todo.length > options.limit) {
    log.info(`依 --limit=${options.limit} 只處理前 ${options.limit} 位`);
    return todo.slice(0, options.limit);
  }
  return todo;
}

/**
 * revoke-dqc 指令。
 *
 * @param {import('./index.mjs').CliOptions} options
 */
export async function runRevokeUnlisted(options) {
  const codes = resolveClearCodes([REVOKE_UNLISTED.code], REVOKE_UNLISTED.protectedCodes);
  const codeName = displayNameOf(REVOKE_UNLISTED.code);
  log.step(`取消名單外的 DACPR 權限：全部名單有、保留名單沒有的人，取消「${codeName}」`);

  const { diff, problems, files } = await compareLists(options);
  if (diff.toRevoke.length === 0) {
    log.ok('全部名單裡的人都在保留名單上，沒有要取消的人。');
    return;
  }

  const progressFile = sweepProgressFile(progressLabel(files.allFiles));
  const work = await pickWork(diff.toRevoke, progressFile, options);
  if (work.length === 0) {
    log.ok('這份名單已經全部處理完了（要整份重做請加 --restart）。');
    return;
  }
  if (options.execute) {
    if (!(await confirmRevoke(work.length, codeName, options))) return;
  } else {
    log.step(`試跑模式：只會看這 ${work.length} 位現在有沒有勾 DQC，不會取消任何權限`);
  }

  const session = await startSession({ freshLogin: options.freshLogin });
  try {
    const results = await clearCodesAll(
      session,
      work,
      {
        execute: options.execute,
        verify: options.verify,
        onProgress: options.execute ? (entry, result) => appendProgress(progressFile, entry, result) : undefined,
        ensureSignedIn: () => ensureSignedIn(session),
      },
      codes,
    );
    printSummary(results);
    const filePath = await writeResultReport(results, {
      execute: options.execute,
      action: '取消',
      title: '一站通 DACPR 權限取消結果（保留名單以外）',
      filePrefix: '取消名單外DACPR結果',
      problems,
    });
    log.ok(`結果清單：${filePath}`);
    log.info('（該檔含姓名，只供核對與補做，請勿外傳）');
    if (options.execute) log.info(`進度已存到：${progressFile}（下次跑會接著做）`);
    await pruneOldResults();
  } finally {
    await session.close();
  }
}
