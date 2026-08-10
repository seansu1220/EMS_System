/**
 * 跑完月報表後的**執行報告**（Markdown）。
 *
 * 使用者 2026-08-10 要求：跑完直接給一份簡短的檔案，講清楚產出狀況、
 * 有哪些要確認、那些案件是什麼情形——而不是要他自己翻幾百行的終端機紀錄。
 *
 * 寫作原則（照使用者的話：「簡單清楚，不要複雜冗長又沒排版」）：
 *   - 先講結論數字，再講要他動手的事，最後才是明細
 *   - 「要你確認的事」**沒有就寫沒有**，不要留一個空標題讓人以為漏了什麼
 *   - 一律用表格，不用長段落
 *
 * ⚠ 個資：與逐案判定表同一個標準——落在 `out/internal/`（不對外），
 *   TEMSIS 只寫末 4 碼（這份是拿來「快速看狀況」的，要逐案核對請開逐案判定表）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { log } from './logger.mjs';
import { maskCode } from './sheetFields.mjs';
import { VERDICT } from './ekgVerify.mjs';

/** 檔名前綴。 */
const SUMMARY_PREFIX = '心電圖執行報告';

/** 產生 `YYYY-MM-DD HH:mm` 格式的當地時間字串。 */
function nowText() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 把 Map 串成 `甲 2 件、乙 1 件`；空的回傳「無」。 */
function describeCounts(counts) {
  if (!counts || counts.size === 0) return '無';
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hant'))
    .map(([squad, count]) => `${squad} ${count} 件`)
    .join('、');
}

/** 算出各種判定各幾件。 */
function countVerdicts(outcomes) {
  const of = (verdict) => outcomes.filter((item) => item.verdict === verdict).length;
  return { before: of(VERDICT.before), after: of(VERDICT.after), unknown: of(VERDICT.unknown) };
}

/**
 * 組出「要你確認的事」。**這是整份報告最重要的一段**，因此每一項都要寫成
 * 「發生什麼事 → 你要做什麼」，不能只丟一個數字。
 *
 * @returns {string[]} 每個元素是一行 Markdown 清單項目
 */
function buildTodoList(outcomes, appeals) {
  const todo = [];

  const pending = outcomes.filter((item) => item.verdict === VERDICT.unknown);
  if (pending.length > 0) {
    todo.push(
      `**${pending.length} 件判定不出來**，目前不計入分子（比率會略低於實際）。`
        + '明細見「心電圖待人工確認」那份，核對後若確實在到院前傳出，請填進申訴表。',
    );
  }

  const unresolved = (appeals?.results ?? []).filter((item) => item.outcome === '無法處理');
  if (unresolved.length > 0) {
    todo.push(
      `申訴表有 **${unresolved.length} 件配對不到系統案件**（TEMSIS 格式不對，且分隊＋地點＋時間也對不上）。`
        + '請回表上確認編號，這幾件這次沒有被算到。',
    );
  }

  const skipped = appeals?.skipped;
  if (skipped?.noDate?.length > 0) {
    todo.push(
      `申訴表第 ${skipped.noDate.join('、')} 列的**案件日期看不出來，整列沒有處理**。`
        + '請改成 `2026/07/08 06:20` 這種寫法（日期和時間之間要有冒號）。',
    );
  }
  if (skipped?.noSquad?.length > 0) {
    todo.push(
      `申訴表第 ${skipped.noSquad.join('、')} 列的**救護車編號推不出分隊**，整列沒有處理。`
        + '請補成 `平鎮91` 這種寫法。',
    );
  }
  return todo;
}

/** 分隊申訴那一段。沒有申訴表就整段不寫。 */
function buildAppealSection(appeals) {
  if (!appeals) return ['## 分隊申訴表', '', '這次沒有讀申訴表（未設定網址或讀取失敗）。', ''];

  const lines = ['## 分隊申訴表', ''];
  if (appeals.results.length === 0) {
    lines.push('這個月沒有落在查詢期間內的申訴案件。', '');
    return lines;
  }

  lines.push(
    `共 ${appeals.results.length} 件。`
      + `分子補進：${describeCounts(appeals.numerator)}；`
      + `分母另外補進：${describeCounts(appeals.denominator)}。`,
    '',
    '| 分隊 | 案件日期 | TEMSIS | 結果 | 配對方式 |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const item of appeals.results) {
    lines.push(
      `| ${item.appeal.squad} | ${item.appeal.caseDate} | ${maskCode(item.appeal.temsis) || '(沒填)'}`
        + ` | ${item.outcome} | ${item.matchedBy || '配對不到'} |`,
    );
  }
  lines.push('');
  return lines;
}

/** 判定不出來的那幾件，逐件列出來（這是使用者最常要追的）。 */
function buildPendingSection(outcomes) {
  const pending = outcomes.filter((item) => item.verdict === VERDICT.unknown);
  if (pending.length === 0) return [];

  const lines = [
    '## 判定不出來的案件',
    '',
    '這些**不計入分子**。要逐案核對請開「心電圖待人工確認」那份（有完整 TEMSIS）。',
    '',
    '| 分隊 | 案件日期 | TEMSIS | 原因 |',
    '| --- | --- | --- | --- |',
  ];
  for (const item of pending) {
    lines.push(
      `| ${item.squad} | ${item.caseDate ?? '(讀不到)'} | ${maskCode(item.temsis)} | ${item.reason} |`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * 寫出執行報告。
 *
 * @param {Object} input
 * @param {import('./dateRange.mjs').MonthRange} input.monthRange
 * @param {Map<string, number>} input.denominatorCounts 已含申訴調整
 * @param {Map<string, number>} input.numeratorCounts 已含申訴調整
 * @param {{ekgChecked: number, twelveLead: number, union: number}} input.sourceCounts 調整前的原始件數
 * @param {import('./ekgVerify.mjs').VerifyOutcome[]} input.outcomes
 * @param {Object|null} input.appeals `applyAppealSheet()` 的回傳
 * @param {string[]} input.files 這次產出的檔案（相對路徑）
 * @returns {Promise<string>} 檔案路徑
 */
export async function writeRunSummary(input) {
  const { monthRange, denominatorCounts, numeratorCounts, sourceCounts, outcomes, appeals } = input;
  const sum = (counts) => [...counts.values()].reduce((total, count) => total + count, 0);
  const denominator = sum(denominatorCounts);
  const numerator = sum(numeratorCounts);
  const ratio = denominator === 0 ? '—' : `${((numerator / denominator) * 100).toFixed(1)}%`;
  const verdicts = countVerdicts(outcomes);
  const todo = buildTodoList(outcomes, appeals);

  const lines = [
    `# ${monthRange.label}　12導程心電圖到院前傳輸率　執行報告`,
    '',
    `產出時間：${nowText()}　／　查詢期間：${monthRange.start} ~ ${monthRange.end}`,
    '',
    '## 結果',
    '',
    '| 項目 | 數字 |',
    '| --- | --- |',
    `| 分母（EKG或12導程） | **${denominator}** |`,
    `| 分子（到院前傳出） | **${numerator}** |`,
    `| 全局傳輸率 | **${ratio}** |`,
    '',
    `分母組成：有勾EKG檢查 ${sourceCounts.ekgChecked} 件 ∪ 有12導程 ${sourceCounts.twelveLead} 件`
      + ` = ${sourceCounts.union} 件${denominator > sourceCounts.union ? `，申訴另補 ${denominator - sourceCounts.union} 件` : ''}。`,
    '',
    '## 逐案查核',
    '',
    '| 判定 | 件數 | 計入分子 |',
    '| --- | --- | --- |',
    `| 到院前傳出 | ${verdicts.before} | 是 |`,
    `| 到院後才傳 | ${verdicts.after} | 否 |`,
    `| 判定不出來 | ${verdicts.unknown} | 否 |`,
    '',
    '## 要你確認的事',
    '',
  ];

  if (todo.length === 0) {
    lines.push('沒有。這次全部都處理完了。', '');
  } else {
    lines.push(...todo.map((item, index) => `${index + 1}. ${item}`), '');
  }

  lines.push(
    ...buildAppealSection(appeals),
    ...buildPendingSection(outcomes),
    '## 這次產出的檔案',
    '',
    ...input.files.map((file) => `- ${file}`),
    '',
    '---',
    '',
    '> 這份報告與逐案判定表都在 `out/internal/`，含全局逐案資料，**不要發給分隊**。',
    '',
  );

  await fs.mkdir(PATHS.internalDir, { recursive: true });
  const filePath = path.join(PATHS.internalDir, `${SUMMARY_PREFIX}-${monthRange.label}.md`);
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  log.ok(`執行報告已寫出：${path.relative(process.cwd(), filePath)}`);
  if (todo.length > 0) log.warn(`　裡面有 ${todo.length} 件事需要你確認，建議先看這份。`);
  return filePath;
}
