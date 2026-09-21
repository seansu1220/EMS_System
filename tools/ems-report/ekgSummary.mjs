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
import { monthlyFileName } from './fileNames.mjs';
import { log } from './logger.mjs';
import { maskCode } from './sheetFields.mjs';
import { VERDICT, countsAsNumerator } from './ekgVerify.mjs';
import { DECISION, REVIEW_COLUMN } from './ekgReview.mjs';

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

/**
 * 算出各種判定各幾件。
 *
 * 到院後**要拆成兩排**（2026-09-21）：備註有補述的計入分子、沒補述的不計入。
 * 合成一排寫「到院後 / 計入分子：否」的話，報告上的數字會與正式報表對不起來，
 * 而這份報告的用處正是「不必翻幾百行紀錄就看得懂這個月發生什麼事」。
 */
function countVerdicts(outcomes) {
  const of = (verdict) => outcomes.filter((item) => item.verdict === verdict).length;
  const afterWithRemark = outcomes.filter(
    (item) => item.verdict === VERDICT.after && countsAsNumerator(item),
  ).length;
  return {
    before: of(VERDICT.before),
    after: of(VERDICT.after) - afterWithRemark,
    afterWithRemark,
    unknown: of(VERDICT.unknown),
  };
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
        + `請開「心電圖-人工判定」那份，看完在「${REVIEW_COLUMN}」欄填`
        + `「${DECISION.count}」或「${DECISION.skip}」，存檔後再跑一次這個月，`
        + '程式就會照你的判定重算。（「心電圖待人工確認」那份是同一批案件的唯讀版本。）',
    );
  }

  const mediaCount = outcomes.reduce((total, item) => total + (item.mediaReviews?.length ?? 0), 0);
  if (mediaCount > 0) {
    todo.push(
      `有 **${mediaCount} 個「案件影音」檔程式讀不出內容**（照片辨識認不出導程名稱），目前不計入分子。`
        + '明細見「心電圖-人工判定」那份（有檔案連結，點開就看得到）。',
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

/**
 * 被排除的 OHCA 案件（處置勾了 CPR）那一段。一件都沒有就整段不寫。
 *
 * ⚠ 這一段**非寫不可**。分隊拿自己的件數來對時，少掉的那幾件如果沒有交代，
 * 就變成一個查不出原因的差異——而排除本身是使用者的規則，不是錯誤，
 * 講清楚反而是這份報告最有價值的地方。
 */
function buildExcludedSection(excluded) {
  if (!excluded || excluded.cases.length === 0) return [];

  const lines = [
    '## 已排除的案件（處置勾了 CPR ＝ OHCA）',
    '',
    `共 ${excluded.cases.length} 件，**分母與分子都不計入**。`
      + 'OHCA 心電圖與 12 導程心電圖是兩回事，不列入 12 導程的傳輸率。',
    '',
    `各分隊：${describeCounts(excluded.countsBySquad)}`,
    '',
    '| 分隊 | 案件日期 | TEMSIS | 原本出現在 |',
    '| --- | --- | --- | --- |',
  ];
  for (const item of excluded.cases) {
    lines.push(`| ${item.squad} | ${item.caseDate} | ${maskCode(item.temsis)} | ${item.from} |`);
  }
  lines.push('', '> 完整 TEMSIS 見逐案判定表，這幾件列在最前面。', '');
  return lines;
}

/** 分隊申訴那一段。沒有申訴表就整段不寫。 */
function buildAppealSection(appeals) {
  if (!appeals) return ['## 分隊申訴表', '', '這次沒有讀申訴表（未設定網址或讀取失敗）。', ''];

  const lines = ['## 分隊申訴表', ''];
  if (appeals.results.length === 0) {
    lines.push('這個月沒有落在查詢期間內的申訴案件。', '');
    return lines;
  }

  // ⚠ 三項都要列。少列「有處置未勾選清冊」那一項，會讓人以為程式只加了分母分子
  //   而沒處理清冊（使用者 2026-08-10 實際這樣誤會過，其實清冊早就補了）。
  lines.push(
    `共 ${appeals.results.length} 件。調整結果：`,
    '',
    '| 調整到哪裡 | 各分隊件數 |',
    '| --- | --- |',
    `| 分子 | ${describeCounts(appeals.numerator)} |`,
    `| 分母（不在兩份查詢結果裡的案件） | ${describeCounts(appeals.denominator)} |`,
    `| 有處置未勾選清冊 | ${describeCounts(appeals.missingProcedure)} |`,
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

/**
 * 到院後補述理由那一段（使用者 2026-09-21 要求：篩完把理由列出來看）。
 *
 * ⚠ 理由**原文照列，不摘要**。這一段的用途是讓使用者自己覆核
 * 「這個理由算不算數」——摘要過的理由沒辦法拿來判斷，等於這一段白寫。
 */
function buildRemarkSection(outcomes, appeals) {
  const fromUpload = outcomes.filter((item) => item.remark);
  const fromAppeal = (appeals?.results ?? []).filter((item) => String(item.appeal?.remark ?? '').trim());
  if (fromUpload.length === 0 && fromAppeal.length === 0) return [];

  const lines = [
    '## 到院後才傳、但有補述原因的案件',
    '',
    `共 ${fromUpload.length} 件是靠上傳清單的備註補回分子的`
      + `${fromAppeal.length > 0 ? `，另有 ${fromAppeal.length} 件申訴表上寫了原因` : ''}。`,
    '',
    '依使用者 2026-09-21 定的規則：到院後才傳，只要備註欄補述了原因就算有在到院前完成；'
      + '沒有補述的不算。**理由原文照列，請自己看一眼合不合理。**',
    '',
    '| 分隊 | 案件日期 | TEMSIS | 來源 | 補述理由 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const item of fromUpload) {
    lines.push(
      `| ${item.squad} | ${item.caseDate ?? '(讀不到)'} | ${maskCode(item.temsis)}`
        + ` | 上傳清單的備註 | ${item.remark.text} |`,
    );
  }
  for (const item of fromAppeal) {
    lines.push(
      `| ${item.appeal.squad} | ${item.appeal.caseDate} | ${maskCode(item.appeal.temsis) || '(沒填)'}`
        + ` | 申訴表第 ${item.appeal.lineNumber} 列 | ${item.appeal.remark} |`,
    );
  }
  lines.push('', '> 完整 TEMSIS 見「心電圖-到院後補述理由」那份。', '');
  return lines;
}

/**
 * 程式判不出內容的案件影音檔那一段。
 *
 * ⚠ 這裡**不寫檔案下載網址**：那串網址帶著案件資料夾編號，
 * 而這份報告是拿來快速看狀況的。要點開看請開 Excel 那份（同樣在 out/internal/）。
 */
function buildMediaSection(outcomes) {
  const reviews = outcomes.flatMap((item) =>
    (item.mediaReviews ?? []).map((review) => ({ item, review })));
  if (reviews.length === 0) return [];

  const lines = [
    '## 判不出內容的「案件影音」檔',
    '',
    `共 ${reviews.length} 個檔案。有人把 12 導程心電圖用「案件影音」這個類型傳上去，`
      + '程式會把檔案抓回來判讀內容；**照片（jpg／png）讀不出來，一律不猜**，列在這裡請你自己看。',
    '',
    '| 分隊 | 案件日期 | TEMSIS | 上傳時間 | 傳的時候到院了沒 | 為什麼判不出來 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const { item, review } of reviews) {
    lines.push(
      `| ${item.squad} | ${item.caseDate ?? '(讀不到)'} | ${maskCode(item.temsis)}`
        + ` | ${review.uploadTime || '(讀不到)'} | ${review.timing} | ${review.why} |`,
    );
  }
  lines.push(
    '',
    '> 檔案連結在「心電圖-案件影音待人工確認」那份 Excel 裡，點開就看得到原始檔案。',
    '> 確認是 12 導程且在到院前傳的，填進分隊申訴表，下次跑就會補進分子。',
    '',
  );
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
 * @param {{cases: import('./ekgExclude.mjs').ExcludedCase[],
 *   countsBySquad: Map<string, number>}} [input.excluded]
 *   因為處置勾了 CPR（OHCA）而排除在分母外的案件
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
  const manualCounted = outcomes.filter((item) => item.manual?.decision === DECISION.count).length;
  const manualSkipped = outcomes.filter((item) => item.manual?.decision === DECISION.skip).length;
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
      + ` = ${sourceCounts.union} 件${denominator > sourceCounts.union ? `，申訴另補 ${denominator - sourceCounts.union} 件` : ''}。`
      + (input.excluded?.cases.length
        ? `（以上已排除 ${input.excluded.cases.length} 件 OHCA——處置勾了 CPR，詳見下方。）`
        : ''),
    '',
    '## 逐案查核',
    '',
    '| 判定 | 件數 | 計入分子 |',
    '| --- | --- | --- |',
    `| 到院前傳出 | ${verdicts.before} | 是 |`,
    `| 到院後才傳，**備註有補述原因** | ${verdicts.afterWithRemark} | 是 |`,
    `| 到院後才傳，備註沒有補述 | ${verdicts.after} | 否 |`,
    `| 判定不出來 | ${verdicts.unknown} | 否 |`,
    '',
    ...(manualCounted + manualSkipped > 0
      ? [
        `其中 **${manualCounted + manualSkipped} 件是依你在人工判定清單上填的結果**`
          + `（「${DECISION.count}」${manualCounted} 件、「${DECISION.skip}」${manualSkipped} 件）。`
          + '人工判定會蓋掉程式的判定，逐案判定表的「依據」欄看得到是哪幾件。',
        '',
      ]
      : []),
    '## 要你確認的事',
    '',
  ];

  if (todo.length === 0) {
    lines.push('沒有。這次全部都處理完了。', '');
  } else {
    lines.push(...todo.map((item, index) => `${index + 1}. ${item}`), '');
  }

  lines.push(
    ...buildExcludedSection(input.excluded),
    ...buildRemarkSection(outcomes, appeals),
    ...buildMediaSection(outcomes),
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
  const filePath = path.join(PATHS.internalDir, monthlyFileName(monthRange, SUMMARY_PREFIX, 'md'));
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  log.ok(`執行報告已寫出：${path.relative(process.cwd(), filePath)}`);
  if (todo.length > 0) log.warn(`　裡面有 ${todo.length} 件事需要你確認，建議先看這份。`);
  return filePath;
}
