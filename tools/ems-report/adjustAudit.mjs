/**
 * 增減試算表的**逐列對帳**——扣除之前先確認「這一列講的案件，真的是沒有到院前預警的那一件嗎」。
 *
 * 為什麼要有這一段（使用者 2026-09-10 要求）：
 * 在這之前，扣除只看試算表的「日期」與「分隊」兩欄，TEMSIS 那一欄**完全沒有被讀過**。
 * 也就是說，分隊只要日期寫在該月內、分隊寫自己，那一件就扣掉了——
 *   - 填一件本來就有預警的案件 → 分子不動、分母變小，比率**不當上升**
 *   - 填一件根本不存在的案件 → 一樣照扣
 * 唯一的防線是「扣到分母小於分子才警告」，門檻寬到形同虛設
 * （2026-08 實測：三民分隊還能再多扣 31 件才會被抓到）。
 *
 * 現在改成先對帳再扣：
 *   1. 以 **TEMSIS** 找出這一列講的是哪一件案子
 *   2. 那一件在「送醫但沒有到院前預警」的清單裡 → **採計**，扣分母 1（分子不動）
 *   3. 那一件在送醫案件裡、但**本來就有預警** → 不採計
 *   4. TEMSIS 在當月送醫案件裡**查無** → 不採計，並在報告裡逐件列出來讓使用者去查
 *   5. 同一個 TEMSIS 被填**第二次** → 不採計（一件案子只能扣一次）
 *
 * ⚠ 採計時扣的是**案件實際所屬分隊**，不是表上填的分隊。
 *   表上填 A 隊、案件其實是 B 隊時，扣 A 隊是算錯的——A 隊的分母裡根本沒有這一件，
 *   扣下去等於從 A 隊拿掉另一件無關的案子。這種情形會另外註記出來。
 *
 * ⚠ 對帳抓得到的是「這件其實有預警」與「查無此案」。
 *   抓不到的是「這件確實沒預警，但填表寫的理由是編的」——理由真不真，程式判不了。
 *
 * ⚠ 個資原則：本模組只回傳判定結果，不輸出任何網址；
 *   終端機與紀錄檔上的 TEMSIS 一律經 `maskCode()` 只顯示末 4 碼，
 *   完整 TEMSIS 只寫進 `out/internal/` 的對帳分頁。
 */
import { log } from './logger.mjs';
import { maskCode } from './sheetFields.mjs';

/** 逐列的判定結果。字串本身會直接印在畫面與對帳分頁上，改字要一起改測試。 */
export const AUDIT_OUTCOME = {
  approved: '採計',
  alerted: '不採計：本來就有預警',
  notFound: '不採計：查無此案',
  duplicate: '不採計：重複提報',
};

/** 對帳分頁的欄位順序即輸出順序。 */
export const AUDIT_COLUMNS = ['試算表列號', '表上填的分隊', '表上填的日期', 'TEMSIS', '判定', '說明', '扣除原因'];

/**
 * @typedef {Object} AuditResult 一列的對帳結果
 * @property {import('./adjustSheet.mjs').AdjustRow} row 試算表上那一列
 * @property {string} outcome {@link AUDIT_OUTCOME} 之一
 * @property {string} squad 實際要扣的分隊；不採計時為空字串
 * @property {string} note 判定說明（給人看的一句話）
 */

/**
 * 逐列對帳（純函式，不碰檔案也不連網）。
 *
 * @param {import('./adjustSheet.mjs').AdjustRow[]} adjustRows 期間內的每一列
 * @param {Map<string, string>} unalertedSquadOf 未預警案件：TEMSIS → 該案實際所屬分隊
 * @param {Set<string>} transportedTemsis 當月**全部送醫案件**的 TEMSIS（用來分辨「有預警」與「查無此案」）
 * @returns {AuditResult[]} 與輸入同順序
 */
export function auditAdjustments(adjustRows, unalertedSquadOf, transportedTemsis) {
  /** 已經採計過的 TEMSIS，用來擋重複提報。 */
  const used = new Set();

  return adjustRows.map((row) => {
    const temsis = row.temsis;

    if (!temsis) {
      return {
        row,
        outcome: AUDIT_OUTCOME.notFound,
        squad: '',
        note: 'TEMSIS 欄是空的，無法確認是哪一件案子',
      };
    }

    const squad = unalertedSquadOf.get(temsis);
    if (squad !== undefined) {
      if (used.has(temsis)) {
        return {
          row,
          outcome: AUDIT_OUTCOME.duplicate,
          squad: '',
          note: '這個 TEMSIS 在表上出現過不只一次，一件案子只扣一次',
        };
      }
      used.add(temsis);
      // 表上填的分隊與案件實際分隊不同時照樣採計，但要講出來——多半是填表的人抄錯欄位。
      const note = squad === row.squad
        ? '這一件確實是送醫但沒有到院前預警，扣除成立'
        : `這一件確實沒有到院前預警，扣除成立；但它是「${squad}」的案件，`
          + `表上填的是「${row.squad}」，已改扣「${squad}」`;
      return { row, outcome: AUDIT_OUTCOME.approved, squad, note };
    }

    if (transportedTemsis.has(temsis)) {
      return {
        row,
        outcome: AUDIT_OUTCOME.alerted,
        squad: '',
        note: '這一件系統登記為「有」到院前預警，本來就算在分子裡，不需要也不應該扣分母',
      };
    }

    return {
      row,
      outcome: AUDIT_OUTCOME.notFound,
      squad: '',
      note: `這個 TEMSIS（${temsis.length} 碼）不在當月的送醫案件裡：`
        + '可能是編號填錯、填成案號、案件日期不在本月，或那件根本沒有送醫',
    };
  });
}

/**
 * 把採計的結果換算成「哪一隊要扣幾件」（純函式）。
 *
 * @param {AuditResult[]} results
 * @returns {Map<string, number>} 分隊 → 扣除件數
 */
export function countApprovedBySquad(results) {
  const counts = new Map();
  for (const result of results) {
    if (result.outcome !== AUDIT_OUTCOME.approved) continue;
    counts.set(result.squad, (counts.get(result.squad) ?? 0) + 1);
  }
  return counts;
}

/**
 * 依判定分類計數（純函式），供摘要顯示。
 * @param {AuditResult[]} results
 * @returns {Map<string, number>}
 */
export function summarizeAudit(results) {
  const counts = new Map(Object.values(AUDIT_OUTCOME).map((outcome) => [outcome, 0]));
  for (const result of results) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  return counts;
}

/**
 * 組出對帳分頁的資料列（純函式）。
 *
 * ⚠ 這裡的 TEMSIS 是**完整**的：這份分頁只落在 `out/internal/`，
 *   而它存在的理由就是讓使用者拿著編號回系統把案件叫出來查。
 *
 * @param {AuditResult[]} results
 * @returns {unknown[][]} 與 {@link AUDIT_COLUMNS} 同順序
 */
export function buildAuditRows(results) {
  const rows = results.map((result) => [
    result.row.lineNumber,
    result.row.squad,
    result.row.caseDate,
    result.row.temsis || '(空白)',
    result.outcome,
    result.note,
    result.row.reason,
  ]);

  // 不採計的排前面：會打開這份分頁的人，要看的就是這些。同組內依試算表列號排。
  const outcomeIndex = AUDIT_COLUMNS.indexOf('判定');
  const lineIndex = AUDIT_COLUMNS.indexOf('試算表列號');
  const rank = (row) => (row[outcomeIndex] === AUDIT_OUTCOME.approved ? 1 : 0);
  return rows.sort(
    (left, right) => rank(left) - rank(right) || Number(left[lineIndex]) - Number(right[lineIndex]),
  );
}

/** 印出一組不採計的列（共用格式：試算表列號在最前面，方便回表上找）。 */
function printRejected(results, outcome, heading) {
  const rejected = results.filter((result) => result.outcome === outcome);
  if (rejected.length === 0) return;
  log.warn(`${heading}：${rejected.length} 件`);
  for (const result of rejected) {
    log.info(
      `　試算表第 ${result.row.lineNumber} 列　${result.row.squad}　${result.row.caseDate}`
        + `　${maskCode(result.row.temsis)}`
        + (result.row.reason ? `　「${result.row.reason}」` : ''),
    );
  }
}

/**
 * 在終端機印出對帳結果。
 *
 * 「查無此案」單獨列出並提醒使用者去確認（使用者 2026-09-10 指定）：
 * 那一群不是程式判錯，是表上的資料有問題，只有人回系統查得出來是哪一種。
 *
 * @param {AuditResult[]} results
 */
export function printAuditReport(results) {
  const counts = summarizeAudit(results);
  log.info(
    `對帳 ${results.length} 列：`
      + Object.values(AUDIT_OUTCOME).map((outcome) => `${outcome} ${counts.get(outcome) ?? 0} 件`).join('、'),
  );

  printRejected(results, AUDIT_OUTCOME.alerted, '這些案件系統登記有到院前預警，不予扣除');
  printRejected(results, AUDIT_OUTCOME.duplicate, '這些是重複提報的同一件案子，只扣第一次');
  printRejected(results, AUDIT_OUTCOME.notFound, '這些 TEMSIS 在當月送醫案件裡查不到，不予扣除，請你確認');

  const misfiled = results.filter(
    (result) => result.outcome === AUDIT_OUTCOME.approved && result.squad !== result.row.squad,
  );
  if (misfiled.length > 0) {
    log.warn(`這些案件的分隊與表上填的不同，已改扣案件實際所屬分隊：${misfiled.length} 件`);
    for (const result of misfiled) {
      log.info(
        `　試算表第 ${result.row.lineNumber} 列　表上填「${result.row.squad}」→ 實際「${result.squad}」`
          + `　${maskCode(result.row.temsis)}`,
      );
    }
  }

  const notFound = counts.get(AUDIT_OUTCOME.notFound) ?? 0;
  if (notFound > 0) {
    log.warn(
      `共有 ${notFound} 件查不到案件，這次沒有扣除。`
        + '完整編號在對帳分頁（out/internal 的未預警清冊），請回系統確認是編號填錯還是案件有問題。',
    );
  }
}
