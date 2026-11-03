/**
 * 救護紀錄表取樣：看「救護紀錄PDF(桃)」實際抽出來長什麼樣子，**但不帶出病患資料**（v1.54.1）。
 *
 * 為什麼要有這一支（使用者 2026-11-03 建議）：結案後比對要判斷「哪一欄改了」，
 * 但從來沒看過紀錄表 PDF 抽出來的實際行結構，欄位規則是照常見版面猜的。
 * 先拿真的紀錄表看過再規劃比對方式。
 *
 * 怎麼做到不帶出個資：抓**好幾張不同案件**的紀錄表，逐段比對——
 *   - 每一張都一模一樣的字 → 表格本身印好的標籤（「姓名」「到院時間」），保留
 *   - 各張不一樣的 → 各案填的值，換成形狀符號（中文 `〇`、數字 `9`、英文 `a`），
 *     只保留它跟別張**共同的開頭與結尾**（`姓名：王小明` vs `姓名：李大華` → `姓名：〇〇〇`）
 * 每一段都附上頁面座標，才看得出標籤與值是不是同一行、欄位怎麼排。
 *
 * 只讀不改系統資料。產出只有遮蔽後的結構檔（`out/internal/紀錄表樣本/`），不存 PDF 原檔。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyDateRange, content, findClickablesWithRetry, submitQuery } from './caseFlow.mjs';
import { PATHS, UNLOCK } from './config.mjs';
import { buildCustomRange } from './dateRange.mjs';
import { log } from './logger.mjs';
import { gotoRecordQuery } from './navigation.mjs';
import { groupByRow } from './pageFinder.mjs';
import { extractPdfItems } from './pdfText.mjs';
import { openRecordSheet } from './recordSheet.mjs';
import { localDateKey, pickSheetButton } from './revisionTrack.mjs';

/** 兩段文字算「同一個位置」的容許誤差（pt）。 */
const POSITION_TOLERANCE = 3;

/** 兩份樣本有多少比例的文字一模一樣，就當成同一件案子（遮蔽不了，不產出）。 */
const SAME_CASE_RATIO = 0.95;

/** 把一段值換成形狀符號：中文 `〇`、數字 `9`、英文 `a`，空白與標點照留（看得出格式）。 */
export function toShape(text) {
  return String(text ?? '')
    .replace(/[0-9０-９]/g, '9')
    .replace(/[A-Za-zＡ-Ｚａ-ｚ]/g, 'a')
    .replace(/[㐀-鿿豈-﫿]/g, '〇');
}

/** 共同開頭的長度。 */
function commonPrefixLength(left, right) {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

/** 共同結尾的長度（不跟開頭重疊）。 */
function commonSuffixLength(left, right, prefix) {
  let length = 0;
  while (
    length < left.length - prefix && length < right.length - prefix
    && left[left.length - 1 - length] === right[right.length - 1 - length]
  ) length += 1;
  return length;
}

/** 標籤與值之間常見的分隔符號。 */
const SEPARATORS = new Set([':', '：', ' ', '　', '(', ')', '（', '）', '[', ']', '【', '】', '/', '／', '、', ',', '，', '|', '｜']);

/** 共同開頭退到「最後一個分隔符號（含）」為止；裡面沒有分隔符號就一個字都不留。 */
function trimPrefixToSeparator(text, length) {
  for (let index = length - 1; index >= 0; index -= 1) {
    if (SEPARATORS.has(text[index])) return index + 1;
  }
  return 0;
}

/** 共同結尾退到「第一個分隔符號（含）」為止。 */
function trimSuffixToSeparator(text, length) {
  for (let offset = length; offset > 0; offset -= 1) {
    if (SEPARATORS.has(text[text.length - offset])) return offset;
  }
  return 0;
}

/**
 * 遮蔽一份樣本（**純函式**）。
 *
 * @param {import('./pdfText.mjs').PdfTextItem[]} target 要遮蔽的那一份
 * @param {import('./pdfText.mjs').PdfTextItem[][]} others 其他案件的樣本（至少一份）
 * @returns {(import('./pdfText.mjs').PdfTextItem & {kept: 'same'|'partial'|'masked'})[]}
 *   `same`＝每一份都有一模一樣的字（標籤）；`partial`＝留了共同的頭尾；`masked`＝整段遮掉
 */
export function maskSample(target, others) {
  const textSets = others.map((items) => new Set(items.map((item) => item.str)));
  return target.map((item) => {
    if (item.str.trim() === '' || textSets.every((set) => set.has(item.str))) {
      return { ...item, kept: 'same' };
    }
    // 在每一份裡找同一頁、同一位置的那一段，保留跟**每一份**都共同的頭尾。
    let prefix = item.str.length;
    let suffix = item.str.length;
    for (const items of others) {
      const counterpart = items.find((other) => other.page === item.page
        && Math.abs(other.x - item.x) <= POSITION_TOLERANCE
        && Math.abs(other.y - item.y) <= POSITION_TOLERANCE);
      if (!counterpart) {
        prefix = 0;
        suffix = 0;
        break;
      }
      const head = commonPrefixLength(item.str, counterpart.str);
      prefix = Math.min(prefix, head);
      suffix = Math.min(suffix, commonSuffixLength(item.str, counterpart.str, head));
    }
    // 共同的頭尾只留到**分隔符號**為止：`姓名：王小明` vs `姓名：王大華` 的共同開頭是 `姓名：王`，
    // 那個「王」是姓氏，不可以留。退到最後一個分隔符號，只留 `姓名：`。
    prefix = trimPrefixToSeparator(item.str, prefix);
    suffix = trimSuffixToSeparator(item.str, suffix);
    if (prefix + suffix >= item.str.length) {
      // 頭尾蓋滿整段＝這一份是別份的一部分（`王小` vs `王小明`），分不出哪裡是值，整段遮掉。
      prefix = 0;
      suffix = 0;
    }
    const middle = item.str.slice(prefix, item.str.length - suffix);
    const str = `${item.str.slice(0, prefix)}${toShape(middle)}${item.str.slice(item.str.length - suffix)}`;
    return { ...item, str, kept: prefix + suffix > 0 ? 'partial' : 'masked' };
  });
}

/**
 * 兩份樣本一模一樣的文字佔多少（判斷是不是同一件案子：那樣就遮不掉個資）。
 * @returns {number} 0 ~ 1
 */
export function sameTextRatio(left, right) {
  if (left.length === 0) return 1;
  const rightSet = new Set(right.map((item) => item.str));
  return left.filter((item) => rightSet.has(item.str)).length / left.length;
}

/**
 * 遮蔽後的結構寫成給人看的文字（**純函式**）。
 *
 * 兩種排法都列：
 *   1. 依座標排成「一列一列」（看欄位怎麼排、標籤與值是不是同一列）
 *   2. 照比對程式現在的切行方式（`hasEOL` 換行）——看現行的逐行比對會拿到什麼
 *
 * @param {ReturnType<typeof maskSample>} items
 * @param {string} title
 * @returns {string}
 */
export function formatSample(items, title) {
  const lines = [`=== ${title} ===`];
  const counts = { same: 0, partial: 0, masked: 0 };
  for (const item of items) counts[item.kept] += 1;
  lines.push(`文字段數 ${items.length}（標籤 ${counts.same}、留頭尾 ${counts.partial}、整段遮蔽 ${counts.masked}）`, '');

  lines.push('--- 一、依座標排列（y 由上到下；每段「x:文字」）---');
  const pages = [...new Set(items.map((item) => item.page))];
  for (const page of pages) {
    lines.push(`[第 ${page} 頁]`);
    const rows = [];
    for (const item of items.filter((entry) => entry.page === page && entry.str.trim() !== '')) {
      const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
      if (row) row.items.push(item);
      else rows.push({ y: item.y, items: [item] });
    }
    rows.sort((left, right) => right.y - left.y);
    for (const row of rows) {
      const cells = row.items.sort((left, right) => left.x - right.x).map((item) => `${Math.round(item.x)}:${item.str}`);
      lines.push(`y=${Math.round(row.y)}\t${cells.join('　｜　')}`);
    }
  }

  lines.push('', '--- 二、照現行比對程式的切行（hasEOL 換行）---');
  const flow = items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
  flow.split('\n').forEach((line, index) => {
    if (line.trim()) lines.push(`${String(index + 1).padStart(3, ' ')}｜${line}`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * 從救護紀錄表查詢的結果裡，挑前幾列（不同列＝不同張紀錄表）開「(桃)」PDF，取出文字與位置。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {{count: number, days: number}} options 取幾張、查最近幾天
 * @returns {Promise<import('./pdfText.mjs').PdfTextItem[][]>}
 */
async function collectSamples(session, options) {
  const { context, page } = session;
  const now = new Date();
  const from = new Date(now.getTime() - options.days * 86400000);
  const range = buildCustomRange(localDateKey(from), localDateKey(now));
  log.step(`救護紀錄表查詢：${range.start} ~ ${range.end}，取前 ${options.count} 張紀錄表當樣本`);
  // 開過一張紀錄表之後，查詢結果的畫面會變（2026-11-03 第一次取樣：第 2 張就找不到按鈕），
  // 所以比照其他流程，**每一張都重新查一次**再取第 N 列。
  const queryRows = async () => {
    await gotoRecordQuery(page);
    await applyDateRange(page, range);
    await submitQuery(page);
    return groupByRow(await findClickablesWithRetry(page, UNLOCK.buttonTexts.openRecordSheet));
  };

  const samples = [];
  for (let position = 0; position < options.count; position += 1) {
    const rows = await queryRows();
    if (rows.length < 2) throw new Error(`查詢期間內只有 ${rows.length} 張紀錄表，至少要 2 張才遮蔽得了`);
    if (position >= rows.length) break;
    const button = pickSheetButton(rows[position], UNLOCK.backup.sheetButtonMarker);
    log.info(`開第 ${samples.length + 1} 張（「${button.text}」）`);
    const sheet = await openRecordSheet(context, content(page), UNLOCK.buttonTexts.openRecordSheet, button.index, {
      keepBytes: true,
      maxPages: UNLOCK.revision.maxPdfPages,
    });
    if (!sheet.bytes) throw new Error('紀錄表不是 PDF 檔（讀到的是網頁），取不了版面');
    samples.push(await extractPdfItems(sheet.bytes, { maxPages: UNLOCK.revision.maxPdfPages }));
  }
  return samples;
}

/**
 * 取樣並寫出遮蔽後的結構檔。
 *
 * @param {import('./session.mjs').EmsSession} session
 * @param {{count?: number, days?: number}} [options]
 * @returns {Promise<string>} 結構檔路徑
 */
export async function runSheetSample(session, options = {}) {
  const samples = await collectSamples(session, { count: options.count ?? 3, days: options.days ?? 7 });
  for (let index = 1; index < samples.length; index += 1) {
    const ratio = sameTextRatio(samples[0], samples[index]);
    if (ratio >= SAME_CASE_RATIO) {
      throw new Error(
        `第 1 張與第 ${index + 1} 張有 ${Math.round(ratio * 100)}% 的文字一模一樣，可能是同一件案子，`
          + '這樣遮不掉個資，已停止（請換一段日期再試：--days=14）',
      );
    }
  }
  const sections = samples.map((items, index) => formatSample(
    maskSample(items, samples.filter((_other, otherIndex) => otherIndex !== index)),
    `第 ${index + 1} 張（${items.length} 段文字）`,
  ));
  const folder = path.join(PATHS.internalDir, '紀錄表樣本');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const filePath = path.join(folder, `${stamp}-紀錄表結構（已遮蔽）.txt`);
  try {
    await fs.mkdir(folder, { recursive: true });
    const header = [
      '救護紀錄PDF(桃) 版面結構（已遮蔽）',
      `取 ${samples.length} 張不同紀錄表比對：每一張都一樣的字保留（表格標籤），不一樣的換成 〇／9／a。`,
      '只看結構用；遮蔽是逐段比對做的，仍請勿外傳。',
      '',
    ].join('\n');
    await fs.writeFile(filePath, `${header}\n${sections.join('\n')}`, 'utf8');
  } catch (error) {
    throw new Error(`紀錄表結構檔寫不進去（${filePath}）：${error instanceof Error ? error.message : error}`);
  }
  log.ok(`已寫出遮蔽後的紀錄表結構：${path.relative(process.cwd(), filePath)}`);
  return filePath;
}
