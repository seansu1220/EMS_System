/**
 * 解鎖前先備份原本的救護紀錄表（v1.54.0，使用者 2026-11-03 指定）。
 *
 * 按下「調整為未結案」之前：
 *   1. 查詢結果那一列的「救護紀錄PDF(桃)」原檔（解鎖流程本來就會開它讀案號，順手留下位元組）
 *      存一份到本機 `out/internal/解鎖前後比對/{案件年月}/{TEMSIS}/`（v1.57.0 起每件一個資料夾）
 *   2. 案件內部**那一張紀錄表同一列**的「上傳」→ 檔案類型選「其他」→ 選這份 PDF
 *      → 檔案說明填 `救護紀錄表內容-v1`（已經備份過幾次就往上加）→ 確定上傳
 *   3. 回讀上傳清單，**真的多出那一列**才算成功
 *
 * 失敗就重試，每次等得更久（`UNLOCK.backup.attemptWaitsMs`）；全部失敗回報失敗，
 * 由呼叫端改報「需人工處理」**不解鎖**——沒留住原本的內容，之後就無從比對（使用者 2026-11-03 決定）。
 *
 * 每次重試都先檢查清單裡是不是**已經有這一版**：上一次其實傳成功了、只是回讀太早沒看到的話，
 * 再傳一次就會在系統裡留下兩份一樣的檔案。
 *
 * ⚠ 個資：PDF 原檔只寫進 `PATHS.revisionDir`（`out/internal/` 底下，不上雲、不給分隊）；
 *   終端機與紀錄檔只印 TEMSIS 末 4 碼與檔案說明。上傳時直接把記憶體裡的位元組交給檔案欄，
 *   不經過暫存檔。
 */
import { content } from './caseFlow.mjs';
import { PATHS, UNLOCK } from './config.mjs';
import { selectField } from './formFill.mjs';
import { log } from './logger.mjs';
import { clickMatch, findField, findFileRows, findPairedRows, findSelectByOption } from './pageFinder.mjs';
import { captureSnapshot } from './probe.mjs';
import {
  buildBackupRemark,
  hasRemark,
  knownVersionsOf,
  loadTracker,
  nextBackupVersion,
  revisionFileNames,
} from './revisionTrack.mjs';
import { TRACKER_FILE, writeRevisionFile } from './revisionFiles.mjs';
import { maskCode } from './sheetFields.mjs';

// 追蹤清單位置原本定義在這裡，v1.57.0 移到 revisionFiles.mjs；照舊從這裡也拿得到。
export { TRACKER_FILE };

/**
 * @typedef {Object} BackupResult
 * @property {boolean} ok 備份成功（試跑時＝預覽成功）
 * @property {boolean} [preview] 試跑模式：只看了上傳畫面，沒有上傳
 * @property {number|null} version 第幾版
 * @property {string|null} remark 檔案說明
 * @property {string|null} backupFile 本機備份檔名（試跑時為 null）
 * @property {string} detail 給人看的說明
 */

/** 等一下（用頁面的計時器，與其他流程一致）。 */
function pause(page, ms) {
  return page.waitForTimeout(ms).catch(() => {});
}

/**
 * 這張紀錄表**同一列**的「上傳」按鈕是第幾個。
 *
 * 一件案子出動幾台車就有幾列、每列各有一顆「上傳」，靠序號猜會傳到別台車的紀錄表，
 * 因此跟解鎖按鈕一樣以同一個 `<tr>` 配對（`findPairedRows`）。
 *
 * @returns {Promise<number>} 按鈕序號；同一列沒有上傳按鈕回傳 -1
 */
async function findUploadButtonIndex(page, recordIndex) {
  const paired = await findPairedRows(
    content(page),
    UNLOCK.buttonTexts.openRecordInCase,
    UNLOCK.backup.uploadButtons,
    // 「上傳」要完全相等，否則會連「確定上傳」一起算進來，序號就錯了。
    { recordExact: false, unlockExact: true },
  );
  const pair = paired.pairs.find((item) => item.recordIndex === recordIndex);
  return pair ? pair.unlockIndex : -1;
}

/** 上傳畫面的「檔案類型」下拉（用選項反推，只有它同時有這些選項）。 */
async function findFileTypeSelect(frame) {
  return findSelectByOption(frame, UNLOCK.backup.fileTypeSelectMarkers).catch(() => null);
}

/** 上傳畫面是不是已經出現了（檔案類型下拉＋檔案欄都在）。 */
async function isUploadFormReady(frame) {
  const select = await findFileTypeSelect(frame);
  if (!select) return false;
  const fileInputs = await frame.locator('input[type="file"]').count().catch(() => 0);
  return fileInputs > 0;
}

/**
 * 按下那一列的「上傳」，等上傳畫面出現。
 * @param {number} uploadIndex 第幾個「上傳」按鈕
 * @param {number} timeoutMs
 */
async function openUploadPanel(page, uploadIndex, timeoutMs) {
  const clicked = await clickMatch(content(page), UNLOCK.backup.uploadButtons, uploadIndex, { exact: true });
  if (!clicked) throw new Error(`按不到第 ${uploadIndex + 1} 個「${UNLOCK.backup.uploadButtons[0]}」按鈕`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUploadFormReady(content(page))) return;
    await pause(page, 500);
  }
  throw new Error(
    `按下「${UNLOCK.backup.uploadButtons[0]}」後 ${Math.round(timeoutMs / 1000)} 秒內沒有出現上傳畫面`
      + '（找不到檔案類型下拉或檔案欄）',
  );
}

/**
 * 讀上傳清單每一列的檔案說明。
 *
 * ⚠ 個資：只回傳檔案說明（人打的字）。清單裡的下載網址帶案件資料夾編號，這裡不帶出去。
 *
 * @returns {Promise<string[]>}
 */
async function readUploadedRemarks(page) {
  const columns = UNLOCK.backup.listColumns;
  const found = await findFileRows(content(page), {
    typeColumns: columns.fileType,
    timeColumns: columns.uploadTime,
    remarkColumns: columns.remark,
    linkColumns: columns.link,
  });
  return (found?.matched ?? []).map((row) => row.remark ?? '');
}

/** 下拉裡文字正好是 `text` 的那個選項值；找不到回傳 null。 */
async function optionValueByText(frame, selector, text) {
  return frame.evaluate(
    ({ fieldSelector, wanted }) => {
      const element = document.querySelector(fieldSelector);
      if (!element) return null;
      const normalize = (value) => String(value ?? '').replace(/\s+/g, '');
      const option = [...element.options].find((item) => normalize(item.textContent) === normalize(wanted));
      return option ? option.value : null;
    },
    { fieldSelector: selector, wanted: text },
  );
}

/** 找「檔案說明／備註」的輸入框：畫面上只有一個文字框就是它，不然照標籤找。 */
async function findRemarkSelector(frame) {
  const textareas = await frame.locator('textarea').count().catch(() => 0);
  if (textareas === 1) return 'textarea';
  const field = await findField(frame, UNLOCK.backup.listColumns.remark).catch(() => null);
  if (field?.selector) return field.selector;
  throw new Error(`上傳畫面上有 ${textareas} 個文字框，認不出哪一個是「檔案說明」`);
}

/**
 * 填好上傳表單並按下「確定上傳」（**會寫入系統**，只在正式模式呼叫）。
 *
 * @param {{bytes: Buffer, fileName: string, remark: string}} file
 * @returns {Promise<string[]>} 系統跳出的訊息（已遮蔽長數字）
 */
async function submitUpload(page, file) {
  const frame = content(page);
  const select = await findFileTypeSelect(frame);
  if (!select) throw new Error('找不到檔案類型下拉');
  const optionValue = await optionValueByText(frame, select.selector, UNLOCK.backup.fileTypeOption);
  if (optionValue === null) {
    throw new Error(`檔案類型下拉裡沒有「${UNLOCK.backup.fileTypeOption}」這個選項`);
  }
  await selectField(frame, select.selector, optionValue, `檔案類型＝${UNLOCK.backup.fileTypeOption}`);

  const fileInputs = frame.locator('input[type="file"]');
  if ((await fileInputs.count()) !== 1) throw new Error('上傳畫面上的檔案欄不只一個，不知道該選哪一個');
  // 直接把記憶體裡的位元組交給檔案欄，不必先寫暫存檔。
  await fileInputs.setInputFiles({ name: file.fileName, mimeType: 'application/pdf', buffer: file.bytes });

  const remarkSelector = await findRemarkSelector(frame);
  await frame.locator(remarkSelector).first().fill(file.remark);
  const typed = await frame.locator(remarkSelector).first().inputValue().catch(() => null);
  if (typed !== file.remark) throw new Error(`檔案說明填入後回讀不符（讀到「${typed ?? '（讀不到）'}」）`);
  log.info(`檔案說明（已確認）：${file.remark}`);

  /** 系統跳出的 alert／confirm。這一步本來就是要上傳，所以確認視窗按「確定」。 */
  const messages = [];
  const onDialog = async (dialog) => {
    const message = dialog.message().replace(/\d{5,}/g, '#####').slice(0, 80);
    messages.push(message);
    log.info(`系統跳出訊息：「${message}」→ 按下確定`);
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  try {
    const clicked = await clickMatch(frame, UNLOCK.backup.submitButtons, 0);
    if (!clicked) throw new Error(`按不到「${UNLOCK.backup.submitButtons[0]}」`);
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await pause(page, 1000);
  } finally {
    page.off('dialog', onDialog);
  }
  return messages;
}

/**
 * 按下確定上傳之後，在 `waitMs` 內一直回讀清單，看這一版出現了沒。
 * 換頁途中讀不到不算失敗，繼續等。
 */
async function waitForRemark(page, remark, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const remarks = await readUploadedRemarks(page).catch(() => null);
    if (remarks && hasRemark(remarks, remark)) return true;
    if (Date.now() >= deadline) return false;
    await pause(page, 1000);
  }
}

/** 把備份 PDF 寫進本機這一件的資料夾（同名就覆蓋：同一版重試時內容一樣）。 */
async function saveLocalBackup(relativePath, bytes) {
  try {
    await writeRevisionFile(relativePath, bytes);
  } catch (error) {
    throw new Error(`解鎖前的紀錄表存不進本機（${PATHS.revisionDir}）：${error instanceof Error ? error.message : error}`);
  }
}

/**
 * 決定這一版的版號與檔名（看系統清單與本機清單，取最大的加一）。
 * @returns {Promise<{version: number, remark: string, names: ReturnType<typeof revisionFileNames>}>}
 */
function planVersion(temsis, remarks, knownVersions) {
  const prefix = UNLOCK.backup.remarkPrefix;
  const version = nextBackupVersion(remarks, prefix, knownVersions);
  return { version, remark: buildBackupRemark(version, prefix), names: revisionFileNames(temsis, version) };
}

/**
 * 解鎖前備份（會重試）。
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {import('playwright-core').Page} page 目前在案件內部
 * @param {{temsis: string, recordIndex: number, bytes: Buffer|null, dryRun: boolean,
 *   reenterCase: () => Promise<unknown>}} input
 *   `bytes`：查詢結果那一列「救護紀錄PDF(桃)」的原檔；`reenterCase`：重新進入這件案子
 * @returns {Promise<BackupResult>} 不丟例外；失敗時 `ok` 為 false，`detail` 寫原因
 */
export async function backupBeforeUnlock(context, page, input) {
  const { temsis, recordIndex, bytes, dryRun, reenterCase } = input;
  const failed = (detail) => ({ ok: false, version: null, remark: null, backupFile: null, detail });
  if (!bytes) {
    return failed('解鎖前要備份的「救護紀錄PDF(桃)」不是 PDF 檔（讀到的是網頁），沒有原檔可以上傳');
  }

  let knownVersions = [];
  try {
    knownVersions = knownVersionsOf(await loadTracker(TRACKER_FILE), temsis);
  } catch (error) {
    // 追蹤清單壞了就不動手：版號可能撞號，之後也記不進清單。
    return failed(error instanceof Error ? error.message : String(error));
  }

  const succeeded = (done, attempt, note) => {
    log.ok(`已備份解鎖前的紀錄表：${done.remark}（TEMSIS ${maskCode(temsis)}）`);
    return {
      ok: true,
      version: done.version,
      remark: done.remark,
      backupFile: done.names.backup,
      detail: `已先備份解鎖前的紀錄表「${done.remark}」（第 ${attempt + 1} 次上傳確認${note}）`,
    };
  };

  const { attemptWaitsMs, panelTimeoutMs } = UNLOCK.backup;
  /** @type {ReturnType<typeof planVersion>|null} */
  let plan = null;
  let localSaved = false;
  let lastError = '';
  for (const [attempt, waitMs] of attemptWaitsMs.entries()) {
    const label = `第 ${attempt + 1}／${attemptWaitsMs.length} 次`;
    try {
      if (attempt > 0) {
        log.info(`備份重試（${label}，這次等 ${waitMs / 1000} 秒）：先重新進入案件`);
        await reenterCase();
      }
      const uploadIndex = await findUploadButtonIndex(page, recordIndex);
      if (uploadIndex < 0) throw new Error(`第 ${recordIndex + 1} 張紀錄表同一列沒有「上傳」按鈕`);
      log.step(`解鎖前先備份紀錄表（第 ${recordIndex + 1} 張，${label}）`);
      await openUploadPanel(page, uploadIndex, panelTimeoutMs * (attempt + 1));

      const remarks = await readUploadedRemarks(page);
      plan ??= planVersion(temsis, remarks, knownVersions);
      if (hasRemark(remarks, plan.remark)) {
        // 上一次其實傳成功了，只是當時回讀太早沒看到：不再傳第二份。
        if (!dryRun && !localSaved) {
          await saveLocalBackup(plan.names.backup, bytes);
          localSaved = true;
        }
        return succeeded(plan, attempt, '（上一次其實已經傳上去了，沒有重傳）');
      }
      if (dryRun) {
        return {
          ok: true,
          preview: true,
          version: plan.version,
          remark: plan.remark,
          backupFile: null,
          detail: `上傳畫面找得到；正式執行時會先上傳備份「${plan.remark}」（檔案類型「${UNLOCK.backup.fileTypeOption}」）再解鎖`,
        };
      }
      if (!localSaved) {
        await saveLocalBackup(plan.names.backup, bytes);
        localSaved = true;
      }
      const messages = await submitUpload(page, { bytes, fileName: plan.names.upload, remark: plan.remark });
      if (await waitForRemark(page, plan.remark, waitMs)) return succeeded(plan, attempt, '');
      lastError = `按下「${UNLOCK.backup.submitButtons[0]}」後 ${waitMs / 1000} 秒內，上傳清單沒有出現「${plan.remark}」`
        + (messages.length > 0 ? `（系統訊息：${messages.join('；')}）` : '');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // 本機存不進去不是畫面問題，重試也沒用。
      if (lastError.startsWith('解鎖前的紀錄表存不進本機')) break;
    }
    log.warn(`備份沒有成功（${label}）：${lastError}`);
  }
  await captureSnapshot(context, '解鎖前備份-上傳失敗');
  return failed(`解鎖前備份紀錄表失敗（試了 ${attemptWaitsMs.length} 次）：${lastError}`);
}
