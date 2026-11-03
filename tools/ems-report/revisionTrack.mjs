/**
 * 解鎖前備份 → 結案後比對的**追蹤清單**（v1.54.0）。
 *
 * 每解鎖一件（而且備份成功），就在 `out/internal/解鎖前後比對/追蹤清單.json` 記一筆：
 * 哪個 TEMSIS、第幾版、備份檔在哪、是不是線上工單（工單編號）。
 * 之後每次開啟線上解鎖工具時（監看則是每天），逐件確認是否已結案，結案了就比對。
 *
 * 這一支只管「清單本身」：版號、檔名、狀態怎麼轉、哪幾件該查——**規則全部是純函式**；
 * 只有 `loadTracker`／`saveTracker`／`addTrackedEntry`／`updateTrackedEntry` 碰檔案。
 *
 * ⚠ 個資：清單裡是**完整 TEMSIS**（回系統查案件非用不可）與本機檔案路徑，
 *   不含病患資料，但仍然只放在 `out/internal/`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { padRange } from './dateRange.mjs';

/**
 * @typedef {'waiting'|'compared'|'superseded'|'expired'|'gaveUp'} RevisionState
 *   `waiting`＝還沒結案，下次再查；`compared`＝已比對；
 *   `superseded`＝還沒等到這一版結案就又被解鎖了（有下一版），改拿下一版的備份來比；
 *   `expired`＝等太久都沒結案；`gaveUp`＝連續失敗太多次，要人來看
 */

/**
 * @typedef {Object} RevisionEntry 追蹤清單的一筆
 * @property {string} temsis 完整 TEMSIS
 * @property {number} version 第幾版（檔案說明的 `-v{N}`）
 * @property {string} remark 上傳時填的檔案說明，例如 `救護紀錄表內容-v1`
 * @property {string} backupFile 解鎖前那份 PDF（相對 `PATHS.revisionDir` 的路徑，例如 `2026-11/{TEMSIS}/{TEMSIS}-v1-解鎖前.pdf`）
 * @property {string} unlockedAt 解鎖時間（ISO）
 * @property {string|null} requestId 線上工單的文件 ID；本機手動解鎖為 null
 * @property {string|null} caseDate
 * @property {string|null} vehicle
 * @property {string|null} squad
 * @property {RevisionState} state
 * @property {string|null} lastCheckedAt 最近一次去系統查的時間（ISO）
 * @property {string|null} lastStatus 最近一次看到的救護狀態
 * @property {string|null} comparedAt 比對完成時間（ISO）
 * @property {string|null} closedFile 結案後那份 PDF 的檔名
 * @property {string|null} reportFile 差異報告的檔名
 * @property {number|null} changeCount 幾處不同
 * @property {string[]} cloudItems 雲端版的差異摘要（不含病患資料）
 * @property {boolean} cloudSynced 雲端（工單）是否已寫入最新狀態
 * @property {number} failCount 連續失敗次數
 * @property {string|null} lastError 最近一次失敗的原因
 */

/**
 * @typedef {Object} Tracker
 * @property {number} formatVersion
 * @property {RevisionEntry[]} entries
 */

/** 追蹤清單的檔案格式版本（欄位改了就加一，舊檔照樣讀得進來）。 */
const TRACKER_FORMAT_VERSION = 1;

/** 壓掉空白、轉大寫（比對檔案說明用）。 */
function compact(text) {
  return String(text ?? '').replace(/[\s　]+/g, '').toUpperCase();
}

/**
 * 從檔案說明讀出版號：`救護紀錄表內容-v2` → 2；不是這種寫法回傳 null。
 *
 * @param {string} remark
 * @param {string} prefix 例如 `救護紀錄表內容-v`
 * @returns {number|null}
 */
export function parseBackupVersion(remark, prefix) {
  const text = compact(remark);
  const key = compact(prefix);
  const at = text.indexOf(key);
  if (at === -1) return null;
  const matched = /^(\d+)/.exec(text.slice(at + key.length));
  return matched ? Number(matched[1]) : null;
}

/**
 * 下一版是第幾版：系統上傳清單裡已有的版號、本機清單記過的版號，取最大的加一。
 *
 * 兩邊都看：系統那邊可能有人工上傳過的版本；本機這邊則是上一次上傳了、
 * 但系統清單讀回來時還沒出現的那一版（不看就會撞號）。
 *
 * @param {string[]} remarks 上傳清單每一列的檔案說明
 * @param {string} prefix
 * @param {number[]} [knownVersions] 本機追蹤清單裡這個 TEMSIS 記過的版號
 * @returns {number}
 */
export function nextBackupVersion(remarks, prefix, knownVersions = []) {
  const versions = [
    ...remarks.map((remark) => parseBackupVersion(remark, prefix)),
    ...knownVersions,
  ].filter((value) => Number.isInteger(value) && value > 0);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

/** 檔案說明：`救護紀錄表內容-v1`。 */
export function buildBackupRemark(version, prefix) {
  return `${prefix}${version}`;
}

/** 上傳清單裡有沒有一列的檔案說明正好是這一版（忽略空白與大小寫）。 */
export function hasRemark(remarks, remark) {
  const wanted = compact(remark);
  return remarks.some((item) => compact(item) === wanted);
}

/** TEMSIS 只留英數（當檔名、資料夾名用）。 */
function safeTemsis(temsis) {
  return String(temsis).replace(/[^0-9A-Za-z]/g, '');
}

/** 看不出案件日期時放的月份資料夾。 */
export const UNKNOWN_MONTH_FOLDER = '案件日期不明';

/**
 * 這一件在 `解鎖前後比對/` 底下的資料夾（v1.57.0，使用者 2026-11-03：檔案要分資料夾，不然很雜）：
 * `{案件年月}/{TEMSIS}`，同一件的每一版（解鎖前、結案後、差異）都在同一個資料夾。
 *
 * 用**案件日期**（TEMSIS 前 8 碼）分月而不是解鎖日期：同一件跨月再解鎖時才不會拆成兩個資料夾。
 * 一律用 `/` 分隔（追蹤清單裡存的是相對路徑，換電腦也讀得到）。
 *
 * @param {string} temsis
 * @returns {string}
 */
export function revisionCaseFolder(temsis) {
  const caseDate = temsisCaseDate(temsis);
  return `${caseDate ? caseDate.slice(0, 7) : UNKNOWN_MONTH_FOLDER}/${safeTemsis(temsis)}`;
}

/**
 * 這一版用到的各個檔名。
 *
 * 上傳到系統的那份用**純英數**（`{TEMSIS}_v1.pdf`）：系統對中文檔名的處理沒驗證過，
 * 先前清單裡看到的檔名也都是英數。本機的檔案則用中文寫清楚是哪一份，
 * 並放進這一件的資料夾（`backup`／`closed`／`report` 是相對 `PATHS.revisionDir` 的路徑）。
 * 檔名仍保留 TEMSIS：單獨把 PDF 拿出來看時還認得是哪一件。
 *
 * @param {string} temsis
 * @param {number} version
 * @returns {{upload: string, backup: string, closed: string, report: string}}
 */
export function revisionFileNames(temsis, version) {
  const safe = safeTemsis(temsis);
  const folder = revisionCaseFolder(temsis);
  return {
    upload: `${safe}_v${version}.pdf`,
    backup: `${folder}/${safe}-v${version}-解鎖前.pdf`,
    closed: `${folder}/${safe}-v${version}-結案後.pdf`,
    report: `${folder}/${safe}-v${version}-差異.txt`,
  };
}

/**
 * 舊版（v1.56.0 以前）檔案全部平放在 `解鎖前後比對/`：算出搬進資料夾後的相對路徑（純函式）。
 * 已經在資料夾裡的（含 `/`）或空值回傳 null＝不必搬。
 *
 * @param {string|null} fileName 追蹤清單記的檔名
 * @param {string} temsis
 * @returns {string|null}
 */
export function folderedRevisionPath(fileName, temsis) {
  if (!fileName || fileName.includes('/')) return null;
  return `${revisionCaseFolder(temsis)}/${fileName}`;
}

/** 救護狀態是不是「已結案」（去空白後開頭相符；`未結案` 不會被誤認）。 */
export function isClosedStatus(status, closedStatus) {
  const text = compact(status);
  return text !== '' && text.startsWith(compact(closedStatus));
}

/**
 * TEMSIS 前 8 碼是案件日期（`2026090710100307554102` → `2026-09-07`）；看不出來回傳 null。
 * @param {string} temsis
 * @returns {string|null}
 */
export function temsisCaseDate(temsis) {
  const matched = /^(\d{4})(\d{2})(\d{2})/.exec(String(temsis ?? ''));
  if (!matched) return null;
  const [, year, month, day] = matched.map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

/** 本地日期 `YYYY-MM-DD`（「今天查過了沒」以辦公室的日曆為準，不是 UTC）。 */
export function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 查這一件要用的查詢期間：案件日期前一天 ~ 今天。
 *
 * 不沿用解鎖的「近兩個月」：解鎖之後可能過了很久才結案，到時案件已經掉出兩個月外，
 * 會被誤判成查無案件。案件日期從 TEMSIS 前 8 碼來，看不出來時才退回近兩個月。
 *
 * @param {string} temsis
 * @param {Date} now
 * @param {(now: Date) => import('./dateRange.mjs').MonthRange} fallback 看不出案件日期時用的期間
 * @returns {import('./dateRange.mjs').MonthRange}
 */
export function buildRevisionQueryRange(temsis, now, fallback) {
  const caseDate = temsisCaseDate(temsis);
  const today = localDateKey(now);
  if (!caseDate || caseDate > today) return fallback(now);
  const padded = padRange({ label: '', start: caseDate, end: today }, 1);
  return { label: `${caseDate} 起至今`, start: padded.start, end: today };
}

/**
 * 解鎖成功（且備份成功）時新增的一筆。
 *
 * @param {{temsis: string, version: number, remark: string, backupFile: string,
 *   requestId?: string|null, caseDate?: string|null, vehicle?: string|null, squad?: string|null}} input
 * @param {Date} now
 * @returns {RevisionEntry}
 */
export function createEntry(input, now) {
  return {
    temsis: input.temsis,
    version: input.version,
    remark: input.remark,
    backupFile: input.backupFile,
    unlockedAt: now.toISOString(),
    requestId: input.requestId ?? null,
    caseDate: input.caseDate ?? null,
    vehicle: input.vehicle ?? null,
    squad: input.squad ?? null,
    state: 'waiting',
    lastCheckedAt: null,
    lastStatus: null,
    comparedAt: null,
    closedFile: null,
    reportFile: null,
    changeCount: null,
    cloudItems: [],
    // 工單那一端在回寫解鎖結果時就會寫入「等待結案」，這裡記成已同步。
    // 本機手動解鎖（沒有工單）本來就不必同步。
    cloudSynced: true,
    failCount: 0,
    lastError: null,
  };
}

/**
 * 把新的一筆放進清單（純函式，回傳新清單）。
 *
 * 同一個 TEMSIS 還有**更早而且還在等**的那一版，代表它還沒等到我們查到結案就又被解鎖了：
 * 那一版標成 `superseded`，之後直接拿這一版的備份（＝那次結案時的內容）來比，不必再回系統查。
 *
 * @param {Tracker} tracker
 * @param {RevisionEntry} entry
 * @returns {Tracker}
 */
export function withEntry(tracker, entry) {
  const entries = tracker.entries
    .filter((item) => !(item.temsis === entry.temsis && item.version === entry.version))
    .map((item) => (item.temsis === entry.temsis && item.version < entry.version && item.state === 'waiting'
      ? { ...item, state: /** @type {RevisionState} */ ('superseded'), cloudSynced: !item.requestId }
      : item));
  return { ...tracker, entries: [...entries, entry] };
}

/**
 * 這一次要處理哪幾筆。
 *
 * @param {Tracker} tracker
 * @param {Date} now
 * @param {{maxWaitDays: number|null, maxFailures: number|null}} config null＝不設限（一直追）
 * @returns {{toCheck: RevisionEntry[], toExpire: RevisionEntry[], toCompareOffline: {entry: RevisionEntry, next: RevisionEntry}[]}}
 *   `toCheck`＝回系統查結案沒；`toExpire`＝等太久，不再追；
 *   `toCompareOffline`＝已被下一版取代，直接拿兩份本機備份比
 */
export function planRevisionWork(tracker, now, config) {
  const toCheck = [];
  const toExpire = [];
  const toCompareOffline = [];
  for (const entry of tracker.entries) {
    if (entry.state === 'superseded' && !entry.comparedAt) {
      const next = tracker.entries
        .filter((item) => item.temsis === entry.temsis && item.version > entry.version)
        .sort((left, right) => left.version - right.version)[0];
      if (next) toCompareOffline.push({ entry, next });
      continue;
    }
    if (entry.state !== 'waiting') continue;
    const waitedDays = (now.getTime() - new Date(entry.unlockedAt).getTime()) / 86400000;
    if (Number.isFinite(config.maxWaitDays) && waitedDays > config.maxWaitDays) toExpire.push(entry);
    else if (Number.isFinite(config.maxFailures) && entry.failCount >= config.maxFailures) continue;
    else toCheck.push(entry);
  }
  return { toCheck, toExpire, toCompareOffline };
}

/**
 * 有沒有「今天還沒查過」的案件（一次性的線上工單要不要為了它登入一次）。
 *
 * @param {Tracker} tracker
 * @param {Date} now
 * @param {{maxWaitDays: number|null, maxFailures: number|null}} config
 * @returns {number} 今天還沒查過的件數
 */
export function countDueToday(tracker, now, config) {
  const today = localDateKey(now);
  const { toCheck, toCompareOffline } = planRevisionWork(tracker, now, config);
  const unchecked = toCheck.filter((entry) => !entry.lastCheckedAt
    || localDateKey(new Date(entry.lastCheckedAt)) !== today);
  return unchecked.length + toCompareOffline.length;
}

/**
 * 這張線上工單要不要備份、追蹤：送出時間在 `trackFrom`（含）之後才要。
 * 申請時間讀不到的一律要——寧可多備份一份，也不要漏掉該追的案件。
 *
 * @param {string} requestedAt ISO 字串（可能是空字串）
 * @param {string} trackFrom ISO 時間（帶時區），例如 `2026-11-03T13:40:00+08:00`
 * @returns {boolean}
 */
export function shouldBackupRequest(requestedAt, trackFrom) {
  const date = new Date(requestedAt ?? '');
  if (!requestedAt || Number.isNaN(date.getTime())) return true;
  return date.getTime() >= new Date(trackFrom).getTime();
}

/** 起算時間寫成人看的樣子：`2026-11-03 13:40`（本地時間）。 */
export function describeCutoff(trackFrom) {
  const date = new Date(trackFrom);
  if (Number.isNaN(date.getTime())) return String(trackFrom);
  const pad = (value) => String(value).padStart(2, '0');
  return `${localDateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 工單上要寫的 `revision` 欄位（**不含病患資料**，見 `src/types/unlockRequest.ts`）。
 *
 * @param {RevisionEntry} entry
 * `lastStatus`（最近一次看到的救護狀態）也寫上去：還沒結案時網頁才顯示得出「案件未結案」
 * （使用者 2026-11-03 要求）。
 *
 * @returns {{version: number, remark: string, state: RevisionState, backedUpAt: string,
 *   lastCheckedAt: string|null, lastStatus: string|null, comparedAt: string|null,
 *   changeCount: number|null, items: string[]}}
 */
export function toCloudRevision(entry) {
  return {
    version: entry.version,
    remark: entry.remark,
    state: entry.state,
    backedUpAt: entry.unlockedAt,
    lastCheckedAt: entry.lastCheckedAt,
    lastStatus: entry.lastStatus ?? null,
    comparedAt: entry.comparedAt,
    changeCount: entry.changeCount,
    items: entry.cloudItems,
  };
}

/** 空的清單。 */
function emptyTracker() {
  return { formatVersion: TRACKER_FORMAT_VERSION, entries: [] };
}

/**
 * 讀追蹤清單；檔案不存在就當作空的。
 *
 * 檔案壞掉時**不可以當成空的**：下一次寫入就會把所有待比對的案件洗掉。
 * 因此直接丟錯，讓呼叫端回報。
 *
 * @param {string} filePath
 * @returns {Promise<Tracker>}
 */
export async function loadTracker(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyTracker();
    throw new Error(`讀不到追蹤清單（${filePath}）：${error instanceof Error ? error.message : error}`);
  }
  try {
    const parsed = JSON.parse(raw);
    return { formatVersion: TRACKER_FORMAT_VERSION, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (error) {
    throw new Error(
      `追蹤清單格式壞掉了（${filePath}）：${error instanceof Error ? error.message : error}。`
        + '請先把它改名備份，程式會建一份新的；舊檔裡的案件要自己對照。',
    );
  }
}

/**
 * 寫追蹤清單：先寫暫存檔再改名，寫到一半被關掉視窗也不會留下半份壞檔。
 * @param {string} filePath
 * @param {Tracker} tracker
 */
export async function saveTracker(filePath, tracker) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(tracker, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

/**
 * 新增一筆並存檔（讀 → 改 → 寫一次完成，不留著舊的副本）。
 * @param {string} filePath
 * @param {RevisionEntry} entry
 */
export async function addTrackedEntry(filePath, entry) {
  await saveTracker(filePath, withEntry(await loadTracker(filePath), entry));
}

/**
 * 更新某一筆並存檔。
 * @param {string} filePath
 * @param {{temsis: string, version: number}} key
 * @param {Partial<RevisionEntry>} patch
 * @returns {Promise<RevisionEntry|null>} 更新後的那一筆；找不到為 null
 */
export async function updateTrackedEntry(filePath, key, patch) {
  const tracker = await loadTracker(filePath);
  let updated = null;
  const entries = tracker.entries.map((item) => {
    if (item.temsis !== key.temsis || item.version !== key.version) return item;
    updated = { ...item, ...patch };
    return updated;
  });
  if (updated) await saveTracker(filePath, { ...tracker, entries });
  return updated;
}

/** 這個 TEMSIS 在本機清單裡記過的版號（推算下一版用）。 */
export function knownVersionsOf(tracker, temsis) {
  return tracker.entries.filter((item) => item.temsis === temsis).map((item) => item.version);
}

/**
 * 查詢結果同一列有兩顆紀錄表按鈕（「救護紀錄PDF」與「救護紀錄PDF(桃)」），挑帶「桃」的那顆；
 * 沒有就退回第一顆（舊版面只有一顆時照常運作）。
 *
 * @template {{text: string}} T
 * @param {T[]} row 同一列的按鈕（`groupByRow` 的一組）
 * @param {string} marker 例如 `桃`
 * @returns {T|null}
 */
export function pickSheetButton(row, marker) {
  if (!Array.isArray(row) || row.length === 0) return null;
  return row.find((button) => String(button?.text ?? '').includes(marker)) ?? row[0];
}

/**
 * 「每天一次」的觸發器（常駐監看跨日時再查一輪）。
 *
 * 只記「上一次做完是哪一天」，日曆換了一天就該再做。剛開啟時已經做過一輪，
 * 呼叫端做完要 `markDone()`，否則開啟當天會連做兩次。
 *
 * @param {() => Date} [now]
 * @returns {{isDue: () => boolean, markDone: () => void}}
 */
export function createDailyTrigger(now = () => new Date()) {
  let lastDay = null;
  return {
    isDue: () => lastDay !== localDateKey(now()),
    markDone: () => {
      lastDay = localDateKey(now());
    },
  };
}
