/**
 * 把「篩選說明」印成 PDF（使用者 2026-10-12 要求）。
 *
 * 同仁會問「這個比率怎麼篩的」，想自己照著做一次核對數字。
 * 說明的原始檔是 `篩選說明/` 裡的 HTML，這裡把它組成完整網頁、用瀏覽器印成 PDF。
 *
 * ## 為什麼是 PDF 而不是 .md
 * 要發給分隊的東西，對方多半用記事本打開 .md，看到的是一堆 `#`、`|`、`**`。
 * PDF 在任何電腦上看起來都一樣。
 *
 * ## 為什麼另外開一個無頭瀏覽器
 * Playwright 的 `page.pdf()` **只能在無頭模式用**，而月報表那個瀏覽器必須有頭
 * （驗證碼要本人輸入）。所以印 PDF 時另外開一個無頭的，印完就關。
 * 用的是同一台電腦上的 Chrome／Edge，不另外下載。
 *
 * ## 失敗只警告
 * 說明是附帶的，印不出來不該讓整份月報表被判定失敗。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BROWSER, GUIDES } from './config.mjs';
import { monthlyFileName } from './fileNames.mjs';
import { log } from './logger.mjs';

/**
 * @typedef {Object} GuideItem
 * @property {string} name 說明名稱，也是產出檔名的主體
 * @property {string} source 原始 HTML 檔名（在 `GUIDES.sourceDir` 裡）
 */

/**
 * 把說明本文與樣式組成一份完整網頁（純函式，方便測試）。
 *
 * @param {string} title 網頁標題（印成 PDF 後是文件標題）
 * @param {string} bodyHtml 說明本文
 * @param {string} css 共用樣式
 * @returns {string}
 */
export function buildGuideHtml(title, bodyHtml, css) {
  return [
    '<!doctype html>',
    '<html lang="zh-Hant">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    `<style>${css}</style>`,
    '</head>',
    `<body>${bodyHtml}</body>`,
    '</html>',
  ].join('\n');
}

/**
 * 產出檔名：有月份就照月報表的規則把年月放前面，沒有就只用名稱。
 *
 * @param {GuideItem} guide
 * @param {import('./dateRange.mjs').MonthRange|null} monthRange
 * @returns {string}
 */
export function guidePdfFileName(guide, monthRange) {
  return monthRange ? monthlyFileName(monthRange, guide.name, 'pdf') : `${guide.name}.pdf`;
}

/** 依序試 Chrome、Edge，開一個無頭瀏覽器。 */
async function launchHeadless() {
  const failures = [];
  for (const channel of BROWSER.channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      failures.push(`${channel}（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）`);
    }
  }
  throw new Error(`找不到可以印 PDF 的瀏覽器，依序試過：${failures.join('、')}`);
}

/**
 * 印一份說明。
 *
 * @param {import('playwright-core').Browser} browser
 * @param {GuideItem} guide
 * @param {string} css
 * @param {string} targetPath
 */
async function printGuide(browser, guide, css, targetPath) {
  const sourcePath = path.join(GUIDES.sourceDir, guide.source);
  const bodyHtml = await fs.readFile(sourcePath, 'utf8');
  const page = await browser.newPage();
  try {
    await page.setContent(buildGuideHtml(guide.name, bodyHtml, css), { waitUntil: 'load' });
    await page.pdf({ ...GUIDES.pdf, path: targetPath });
  } finally {
    await page.close();
  }
}

/**
 * 把全部說明印成 PDF。
 *
 * @param {string} targetDir 放到哪個資料夾
 * @param {import('./dateRange.mjs').MonthRange|null} monthRange 有給就把年月放在檔名前面
 * @returns {Promise<string[]>} 成功印出的檔案路徑
 */
export async function writeGuidePdfs(targetDir, monthRange = null) {
  let css;
  let browser;
  try {
    css = await fs.readFile(path.join(GUIDES.sourceDir, GUIDES.styleFile), 'utf8');
    await fs.mkdir(targetDir, { recursive: true });
    browser = await launchHeadless();
  } catch (error) {
    log.warn(`篩選說明 PDF 印不出來（不影響報表）：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const written = [];
  try {
    for (const guide of GUIDES.items) {
      const targetPath = path.join(targetDir, guidePdfFileName(guide, monthRange));
      try {
        await printGuide(browser, guide, css, targetPath);
        written.push(targetPath);
      } catch (error) {
        log.warn(`「${guide.name}」印不出來（不影響報表）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  if (written.length > 0) log.ok(`篩選說明已印成 PDF：${written.map((filePath) => path.basename(filePath)).join('、')}`);
  return written;
}
