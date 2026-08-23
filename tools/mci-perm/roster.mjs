/**
 * 名單解析：把使用者給的「單位＋姓名」整理成程式看得懂的清單。
 *
 * 兩種來源都支援，因為兩種都是真實用法：
 *   1. 從 Excel 複製一整段貼進黑視窗（每行「單位,姓名」或「單位<tab>姓名」）
 *   2. 直接給檔案（`--file=名單.xlsx`，也吃 .csv／.txt）
 *
 * ⚠ 個資原則：姓名屬個人資料。本模組只做解析，**不寫任何檔案、不輸出到 log**；
 *   要顯示時一律先經過 logger 的 `maskName`。
 */
import path from 'node:path';

/**
 * @typedef {Object} RosterEntry
 * @property {string} unit 單位（會拿去比對下拉選單，用「包含」比對）
 * @property {string} name 姓名。**從系統畫面掃來的名單裡，這是遮蔽過的顯示文字**
 *   （`許O軒`）——那就是承辦人在系統上看得到的東西，進度檔與結果清單都用它
 * @property {number} lineNumber 來源的第幾行／第幾列（1 起算，出問題時指得出是哪一筆）
 * @property {string} [unitValue] 單位下拉的 value（掃描時抄回來的，選單位最精準）
 * @property {string} [searchName] 要填進「姓名」欄的字。姓名被遮蔽時只有沒被遮到的
 *   那一段能查（見 `unitSweep.splitMaskedName`）；沒有這一欄就用 `name`
 * @property {string} [rowText] 姓名遮蔽時，用來在查詢結果裡認出「是哪一列」的顯示文字
 *   （見 `grantFlow.locatePerson`）。空字串代表姓名沒被遮，走「查到剛好一筆」那條路
 */

/**
 * @typedef {Object} RosterProblem
 * @property {number} lineNumber
 * @property {string} reason 為什麼這一行不能用（訊息裡不含姓名，只描述問題）
 */

/**
 * @typedef {Object} RosterResult
 * @property {RosterEntry[]} entries 可以處理的清單（已去重）
 * @property {RosterProblem[]} problems 讀不懂或缺欄位的行
 * @property {number} duplicateCount 被視為重複而併掉的筆數
 */

/** 欄位分隔符：半形/全形逗號、tab、頓號、連續空白。 */
const SEPARATOR = /[,，\t、]|\s{2,}| /;

/**
 * 標題列的字樣（貼上時常會連標題一起複製到）。
 *
 * 「部門」「機關」也要算：這個系統的下拉就叫「部門」，
 * 使用者的 Excel 標題很可能照抄系統的用詞。
 */
const HEADER_WORDS = ['單位', '姓名', '名字', '人員', '部門', '機關'];

/** 去掉 BOM、前後空白與包住整段的引號。 */
function tidy(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .trim()
    .replace(/^["'](.*)["']$/, '$1')
    .trim();
}

/** 這一行看起來是標題列嗎（例如「單位　姓名」）。 */
function looksLikeHeader(unit, name) {
  const both = `${unit}${name}`;
  if (!both) return false;
  const hits = HEADER_WORDS.filter((word) => both.includes(word));
  // 「單位」「姓名」同時出現，且整行很短，才判定成標題——
  // 真的有人單位就叫「XX救護隊」而姓名裡不會有「姓名」兩字。
  return hits.length >= 2 && both.length <= 12;
}

/**
 * 從標題列看出「哪一欄是姓名」。
 *
 * 為什麼需要：貼上的內容沒有欄位名稱可查，程式只能假設一個順序。
 * 但使用者的 Excel 很可能是**姓名在前、單位在後**，照預設解析會整份顛倒
 * ——單位變成人名，一個都查不到。連標題一起貼上時就問得出正確答案。
 *
 * @param {string} line
 * @returns {boolean|null} true＝姓名在前；null＝這行不是標題列
 */
function detectNameFirst(line) {
  const match = line.match(SEPARATOR);
  if (!match || match.index === undefined) return null;
  const first = tidy(line.slice(0, match.index));
  const second = tidy(line.slice(match.index + match[0].length));
  if (!looksLikeHeader(first, second)) return null;
  const isName = (text) => text.includes('姓名') || text.includes('名字');
  const isUnit = (text) => text.includes('單位') || text.includes('機關') || text.includes('部門');
  if (isName(first) && isUnit(second)) return true;
  if (isUnit(first) && isName(second)) return false;
  return null;
}

/**
 * 解析一行文字。
 *
 * 規則刻意簡單：**第一個分隔符前面是單位，後面全部是姓名**（只切一刀）。
 * 分隔符包含單一空白，因為手打時最自然的寫法就是「大溪分隊 王小明」；
 * 代價是單位名稱本身若含空白會被切斷，那種情況會在比對下拉選單時
 * 以「沒有相符的選項」被擋下來並印出候選，不會默默開錯單位。
 *
 * @param {string} rawLine
 * @param {{defaultUnit?: string}} [options]
 * @returns {{unit: string, name: string} | null} 空行回傳 null
 */
export function parseRosterLine(rawLine, options = {}) {
  const line = tidy(rawLine);
  if (!line) return null;

  const match = line.match(SEPARATOR);
  if (!match || match.index === undefined) {
    // 只有一欄：當成姓名，單位用預設值（沒有預設值的話由呼叫端記成問題）。
    return { unit: tidy(options.defaultUnit ?? ''), name: line };
  }
  const first = tidy(line.slice(0, match.index));
  const second = tidy(line.slice(match.index + match[0].length));
  // 預設「單位在前」；標題列指出姓名在前時（見 detectNameFirst）就對調。
  const unit = options.nameFirst ? second : first;
  const name = options.nameFirst ? first : second;
  return { unit: unit || tidy(options.defaultUnit ?? ''), name };
}

/**
 * 解析多行名單。
 *
 * @param {string[]|string} input 多行字串或已切好的行陣列
 * @param {{defaultUnit?: string}} [options]
 * @returns {RosterResult}
 */
export function parseRoster(input, options = {}) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  // 先看第一個有內容的行是不是標題列；是的話由它決定欄序。
  let nameFirst = options.nameFirst ?? false;
  for (const rawLine of lines) {
    const line = tidy(rawLine);
    if (!line) continue;
    const detected = detectNameFirst(line);
    if (detected !== null) nameFirst = detected;
    break;
  }
  const lineOptions = { ...options, nameFirst };
  const pairs = lines.map((rawLine, index) => {
    const parsed = parseRosterLine(rawLine, lineOptions);
    return parsed ? { ...parsed, lineNumber: index + 1 } : null;
  });
  return buildResult(pairs, options);
}

/**
 * 把「單位／姓名」的清單整理成最終結果：略過標題與空行、記下缺欄位的、去重。
 *
 * 貼上與 Excel 兩條路都走這裡，規則只有一份。
 *
 * ⚠ 刻意收**結構化的資料**而不是字串：早期 Excel 那條路是把兩欄串成
 * `單位<tab>姓名` 再切開，結果「有單位、沒姓名」的列尾端分隔符被 trim 掉，
 * 反而被報成「沒有單位」，害人去改錯的地方（2026-08-21 實際名單踩到）。
 *
 * @param {({unit: string, name: string, lineNumber: number}|null)[]} pairs
 * @param {{defaultUnit?: string}} [options]
 * @returns {RosterResult}
 */
function buildResult(pairs, options = {}) {
  /** @type {RosterEntry[]} */
  const entries = [];
  /** @type {RosterProblem[]} */
  const problems = [];
  const seen = new Set();
  let duplicateCount = 0;

  for (const pair of pairs) {
    if (!pair) continue; // 空行直接略過，不算問題
    const unit = tidy(pair.unit) || tidy(options.defaultUnit ?? '');
    const name = tidy(pair.name);
    const lineNumber = pair.lineNumber;

    if (looksLikeHeader(unit, name)) continue; // 標題列略過
    if (!unit && !name) continue; // 整列空白

    if (!name) {
      problems.push({ lineNumber, reason: `這一列有單位「${unit}」但沒有姓名` });
      continue;
    }
    if (!unit) {
      problems.push({
        lineNumber,
        reason: '這一列沒有單位，.env 也沒設定 MCI_DEFAULT_UNIT（單位不能用猜的）',
      });
      continue;
    }
    const key = `${unit} ${name}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    entries.push({ unit, name, lineNumber });
  }

  return { entries, problems, duplicateCount };
}

/** 認得出來的名單檔副檔名。 */
const FILE_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.csv', '.txt'];

/**
 * 使用者是不是「把檔案拖進黑視窗」了？
 *
 * 拖檔案到 Windows 主控台視窗，等於貼上一行檔案路徑（含空格時還會自動加引號）。
 * 這是很自然的操作，卻會讓路徑被當成某個人的姓名去查
 * ——2026-08-20 使用者實際踩到，畫面上出現「第 1 行沒有單位」。
 *
 * @param {string[]} lines
 * @returns {string} 檔案路徑；不是這種情況時回空字串
 */
export function detectDroppedFile(lines) {
  const meaningful = (lines ?? []).map(tidy).filter(Boolean);
  if (meaningful.length !== 1) return ''; // 混著名單就不是拖檔案
  const candidate = meaningful[0];
  return FILE_EXTENSIONS.includes(path.extname(candidate).toLowerCase()) ? candidate : '';
}

/**
 * 把「使用者輸入的那幾行」變成名單：拖進來的是檔案就讀檔，否則當成貼上的名單。
 *
 * @param {string[]} lines
 * @param {{defaultUnit?: string}} [options]
 * @returns {Promise<RosterResult & {sourceFile?: string}>}
 */
export async function resolveRosterInput(lines, options = {}) {
  const dropped = detectDroppedFile(lines);
  if (!dropped) return parseRoster(lines, options);
  const result = await readRosterFile(dropped, options);
  return { ...result, sourceFile: dropped };
}

/**
 * 從檔案讀名單（.xlsx / .xls / .csv / .txt）。
 *
 * Excel 走 SheetJS，其餘當純文字讀。Excel 會先找含「姓名」的標題列；
 * 找不到標題就退回「第一欄是單位、第二欄是姓名」的位置慣例。
 *
 * @param {string} filePath
 * @param {{defaultUnit?: string}} [options]
 * @returns {Promise<RosterResult>}
 */
export async function readRosterFile(filePath, options = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (['.xlsx', '.xls', '.xlsm'].includes(extension)) {
    return readExcelRoster(filePath, options);
  }
  const { readFile } = await import('node:fs/promises');
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`讀不到名單檔 ${filePath}：${reason}`);
  }
  return parseRoster(text, options);
}

/** 把 Excel 讀成「單位／姓名」兩欄。 */
async function readExcelRoster(filePath, options) {
  const { default: XLSX } = await import('./xlsxNode.mjs');
  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`無法讀取名單檔 ${filePath}：${reason}`);
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error(`名單檔 ${filePath} 沒有任何工作表`);
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: '',
    blankrows: false,
  });
  return parseRosterMatrix(matrix, options);
}

/**
 * 把二維陣列（Excel 讀出來的樣子）解析成名單。
 * 抽成獨立函式是為了能直接測，不必真的做一個 Excel 檔。
 *
 * @param {unknown[][]} matrix
 * @param {{defaultUnit?: string}} [options]
 * @returns {RosterResult}
 */
export function parseRosterMatrix(matrix, options = {}) {
  const rows = (matrix ?? []).map((row) => (Array.isArray(row) ? row.map(tidy) : []));
  let unitColumn = 0;
  let nameColumn = 1;
  let startRow = 0;

  const headerRowIndex = rows.findIndex((row) => row.some((cell) => cell === '姓名' || cell === '名字'));
  if (headerRowIndex >= 0) {
    const header = rows[headerRowIndex];
    nameColumn = header.findIndex((cell) => cell === '姓名' || cell === '名字');
    const foundUnit = header.findIndex(
      (cell) => cell.includes('單位') || cell.includes('機關') || cell.includes('部門'),
    );
    unitColumn = foundUnit >= 0 ? foundUnit : nameColumn === 0 ? 1 : 0;
    startRow = headerRowIndex + 1;
  }

  // 直接給結構化資料：欄位已經分好了，不要再串成字串切一次（見 buildResult 的說明）。
  const pairs = rows.slice(startRow).map((row, index) => ({
    unit: tidy(row[unitColumn] ?? ''),
    name: tidy(row[nameColumn] ?? ''),
    // 行號對回 Excel 的實際列號，方便使用者回去看是哪一列。
    lineNumber: startRow + index + 1,
  }));
  return buildResult(pairs, options);
}
