/**
 * 增減資料來源：Google 試算表。
 *
 * 用途：某些案件雖然在系統中被計為「有送醫」，但實際上不應列入分母，
 * 需依這份試算表逐筆扣除（每一列扣該分隊 1 件）。
 *
 * 取得方式：直接讀 Google 試算表的 CSV 匯出網址，不需要 API 金鑰，
 * 但該試算表必須設為「**知道連結的人可以檢視**」。
 *
 * ⚠ 個資原則：
 *   - 試算表網址只從 `.env` 讀取（已 gitignore），**任何輸出都不顯示網址**
 *   - `describeSheet` 只回報欄名與型態推測，**不回報任何儲存格內容**
 */
import path from 'node:path';
import { PATHS } from './config.mjs';

/**
 * @typedef {Object} SheetSource
 * @property {string} spreadsheetId 試算表 ID
 * @property {string} gid 分頁 gid
 * @property {string} csvUrl CSV 匯出網址（僅內部使用，不對外輸出）
 */

/** 讀取 .env 並解析出試算表來源；未設定時回傳 null。 */
export function resolveSheetSource() {
  try {
    process.loadEnvFile(path.join(PATHS.toolDir, '.env'));
  } catch {
    // 沒有 .env 屬正常情況。
  }
  const url = (process.env.EMS_ADJUST_SHEET_URL ?? '').trim();
  if (!url) return null;

  const idMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url);
  if (!idMatch) {
    throw new Error(
      'EMS_ADJUST_SHEET_URL 看起來不是 Google 試算表網址（找不到 /spreadsheets/d/... 這段）。' +
        '請把瀏覽器網址列的整串網址貼上。',
    );
  }
  const gidFromUrl = /[#&?]gid=(\d+)/.exec(url)?.[1];
  const gid = (process.env.EMS_ADJUST_SHEET_GID ?? '').trim() || gidFromUrl || '0';
  return {
    spreadsheetId: idMatch[1],
    gid,
    csvUrl: `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`,
  };
}

/**
 * 最小 CSV 解析器（處理引號、逸出引號與跨行儲存格）。
 * @param {string} input
 * @returns {string[][]}
 */
export function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

/**
 * 抓取試算表內容並解析為列陣列（第一列為欄位標題）。
 * @param {SheetSource} source
 * @returns {Promise<string[][]>}
 */
export async function fetchSheetRows(source) {
  let response;
  try {
    response = await fetch(source.csvUrl, { redirect: 'follow' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`連線到 Google 試算表失敗：${reason}`);
  }
  if (!response.ok) {
    throw new Error(`讀取 Google 試算表失敗（HTTP ${response.status}）`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!/csv|text\/plain/i.test(contentType)) {
    throw new Error(
      '這份試算表沒有開放存取，讀到的是登入頁而不是資料。' +
        '請在試算表右上角「共用」中，把一般存取權改為「知道連結的任何人」→「檢視者」。',
    );
  }
  return parseCsv(text);
}

/**
 * 只回報結構的診斷資訊，供確認欄位對應用。
 * **不回報任何儲存格內容**，只回報欄名與型態推測。
 *
 * @param {string[][]} rows
 * @returns {{rowCount: number, columnCount: number, columns: {index: number, header: string, filled: number, distinct: number, kinds: string[]}[]}}
 */
export function describeSheet(rows) {
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const columnCount = Math.max(0, ...rows.map((row) => row.length));

  const columns = [];
  for (let index = 0; index < columnCount; index += 1) {
    const values = body.map((row) => (row[index] ?? '').trim()).filter(Boolean);
    const ratioOf = (predicate) =>
      values.length === 0 ? 0 : values.filter(predicate).length / values.length;

    const kinds = [];
    if (ratioOf((value) => /\d{2,4}[-/]\d{1,2}[-/]\d{1,2}/.test(value)) > 0.7) kinds.push('日期');
    if (ratioOf((value) => /\d{1,2}:\d{2}/.test(value)) > 0.7) kinds.push('時間');
    if (ratioOf((value) => /(分隊|大隊|中隊)$/.test(value)) > 0.7) kinds.push('分隊名稱');
    if (ratioOf((value) => /^-?\d+(\.\d+)?$/.test(value)) > 0.7) kinds.push('數字');

    columns.push({
      index,
      header: (headers[index] ?? '').trim().slice(0, 40),
      filled: values.length,
      distinct: new Set(values).size,
      kinds,
    });
  }
  return { rowCount: rows.length, columnCount, columns };
}
