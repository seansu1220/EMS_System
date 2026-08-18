/**
 * 頁面結構探測：把這個系統各畫面「有哪些欄位、按鈕、下拉選項」記下來。
 *
 * 用途有兩個：
 *   1. 第一次接這個系統時，用它把真實結構帶回來（開發時據此調整定位設定）
 *   2. 系統改版、流程卡住時，用它看出畫面變成什麼樣子
 *
 * ⚠ 個資原則（與 tools/ems-report 的探測模式相同）：
 *   - 只記錄**欄位名稱、按鈕文字、下拉選項**這類表單結構，不取任何資料列內容
 *   - 5 碼以上連續數字一律遮蔽（見 domFind.mjs）
 *   - 不截圖
 *   - 查詢結果只記「有幾列」，不記任何一列寫了什麼
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, SITE, TIMING } from './config.mjs';
import {
  countDataRows,
  findClickables,
  listClickableTexts,
  listFields,
  listSelects,
} from './domFind.mjs';
import { openAccountPermissionPage, waitForOptions } from './grantFlow.mjs';
import { log } from './logger.mjs';

/** 把一個畫面的結構整理成 Markdown 段落。 */
async function describePage(page, title) {
  const lines = [`## ${title}`, ``];
  const frames = page.frames();
  lines.push(
    `- 網址：${page.url()}`,
    `- 分頁標題：${await page.title().catch(() => '(讀不到)')}`,
    `- 同時開著幾個分頁：${page.context().pages().length}`,
    `- 版面：${frames.length} 個 frame（${frames.map((frame) => frame.name() || '主文件').join('、')}）`,
    ``,
  );

  for (const frame of frames) {
    const frameName = frame.name() || '主文件';
    const fields = await listFields(frame).catch(() => []);
    const selects = await listSelects(frame, { optionLimit: 200 }).catch(() => []);
    const clickables = await listClickableTexts(frame, 60).catch(() => []);
    if (fields.length === 0 && clickables.length === 0) continue;

    lines.push(`### frame：${frameName}`, ``);
    if (frames.length > 1) lines.push(`- frame 網址：${frame.url()}`, ``);
    if (fields.length > 0) {
      // 標籤認不出來時，id／name／placeholder 就是判斷「這一欄是什麼」的唯一線索，
      // 因此每一欄都完整列出來（2026-08-18 實跑就是卡在三個「沒有標籤」的欄位）。
      lines.push(`**欄位**（標籤／類型／id／name／提示文字）`, ``);
      for (const field of fields) {
        const type = field.type ? `${field.tag}:${field.type}` : field.tag;
        lines.push(
          `- ${field.nearbyText || '(沒有標籤)'}｜${type}` +
            `｜id=${field.id || '無'}｜name=${field.name || '無'}` +
            `｜提示=${field.hint || '無'}${field.visible ? '' : '｜(看不見)'}`,
        );
      }
      lines.push(``);
    }
    if (selects.length > 0) {
      lines.push(`**下拉選單與選項**`, ``);
      for (const select of selects) {
        lines.push(
          `- ${select.nearbyText || '(沒有標籤)'}｜id=${select.id || '無'}｜name=${select.name || '無'}` +
            `｜共 ${select.optionCount} 個選項`,
        );
        for (const option of select.options) {
          if (option) lines.push(`  - ${option}`);
        }
      }
      lines.push(``);
    }
    if (clickables.length > 0) {
      lines.push(`**可以按的東西**`, ``, clickables.map((item) => `\`${item.text}\``).join('、'), ``);
    }
  }
  return lines;
}

/**
 * 執行探測。
 *
 * @param {import('./session.mjs').PermSession} session
 * @param {{unit?: string, name?: string}} [options]
 *   給了單位與姓名時會多走一段：查一個人 → 進入權限畫面，把那兩頁的結構也記下來。
 *   **不會按任何確定鍵**，只看不動。
 * @returns {Promise<string>} 產出的檔案路徑
 */
export async function runProbe(session, options = {}) {
  const page = session.page;
  const lines = [
    `# 大量傷患系統 頁面結構探測`,
    ``,
    `- 探測時間：${new Date().toLocaleString('zh-TW')}`,
    `- 只記錄欄位／按鈕／下拉選項等表單結構，不取任何資料內容（5 碼以上數字已遮蔽）`,
    ``,
  ];

  log.step('探測：登入後的主畫面');
  lines.push(...(await describePage(page, '登入後的主畫面')));

  log.step('探測：右上角「你好」選單');
  const userMenu = await findClickables(page.mainFrame(), SITE.flow.userMenuTexts).catch(() => []);
  lines.push(
    `## 右上角的使用者選單`,
    ``,
    userMenu.length > 0
      ? `- 找到 ${userMenu.length} 個含「你好」的元素：${userMenu.map((hit) => `\`${hit.text}\``).join('、')}`
      : `- ⚠ 找不到含「你好」的元素（設定裡的 userMenuTexts 可能要改）`,
    ``,
  );

  log.step('探測：帳號子系統權限的查詢畫面');
  const opened = await openAccountPermissionPage(session);
  if (!opened.ok) {
    lines.push(
      `## 帳號子系統權限（進不去）`,
      ``,
      `- 卡在：${opened.step}`,
      `- 原因：${opened.detail}`,
      `- 當時畫面上看得到：${(opened.candidates ?? []).join('、')}`,
      ``,
    );
    // 進不去才是最需要完整記錄的時候：把當時的畫面整個記下來，
    // 才有辦法看出「到底停在哪一頁、那些沒有標籤的欄位是什麼」。
    lines.push(...(await describePage(session.context.pages().at(-1) ?? page, '卡住時的畫面')));
    log.warn(`進不去查詢畫面：${opened.detail}`);
    return writeProbeFile(lines);
  }
  // 單位清單是進頁面後才由伺服器載入的，不等就記錄會得到一個「0 個選項」的空下拉
  // （2026-08-18 第一次探測就是這樣，等於白跑）。
  const loaded = await waitForOptions(opened.frame, SITE.flow.querySelectors.unit);
  log.info(loaded ? '單位清單已載入' : '等不到單位清單載入（下面記到的選項可能是空的）');
  lines.push(...(await describePage(session.context.pages().at(-1) ?? page, '帳號子系統權限：查詢畫面')));

  if (options.unit && options.name) {
    log.step('探測：查一個人看看結果畫面長什麼樣（不會做任何設定）');
    const { grantOne } = await import('./grantFlow.mjs');
    // 借用正式流程走到「選好角色、停在確定之前」，過程中不按確定。
    const result = await grantOne(session, { unit: options.unit, name: options.name, lineNumber: 0 }, { execute: false });
    const currentPage = session.context.pages().at(-1) ?? page;
    lines.push(
      `## 試走一次的結果`,
      ``,
      `- 結果：${result.outcome}`,
      `- 走到：${result.step}`,
      `- 說明：${result.detail}`,
      `- 查詢結果列數：${await countDataRows(currentPage.mainFrame()).catch(() => '(數不到)')}`,
      ``,
    );
    lines.push(...(await describePage(currentPage, '停下來時的畫面')));
  } else {
    lines.push(
      `## 沒有試走查人`,
      ``,
      `- 要連結果畫面與權限畫面一起探測，請加上 \`--unit=單位 --name=姓名\`（過程中不會按確定）`,
      ``,
    );
  }

  await page.waitForTimeout(TIMING.retryIntervalMs);
  return writeProbeFile(lines);
}

/** 把探測結果寫成檔案。 */
async function writeProbeFile(lines) {
  await fs.mkdir(PATHS.probeDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const filePath = path.join(PATHS.probeDir, `頁面結構-${stamp}.md`);
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  log.ok(`探測結果已寫入：${filePath}`);
  return filePath;
}
