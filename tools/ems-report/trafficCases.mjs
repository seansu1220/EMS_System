/**
 * 二級以上因交通事故救護案件——把系統匯出的明細整理成「來文格式」的列。
 *
 * 這一支全部是純函式：只做資料轉換，不開瀏覽器、不讀檔、不寫檔。
 * 兩張工作表（詳細報表一／詳細報表二）靠「救護紀錄表單號」串起來，
 * 來文要的欄位剛好分散在兩張裡（姓名與到院前檢傷分級在第二張）。
 *
 * ⚠ 個資：處理過程含姓名與身分證字號，只留在記憶體，本模組不輸出任何檔案與紀錄。
 */

/**
 * @typedef {Object} SheetPair 一次查詢（一個檢傷等級）匯出的兩張工作表
 * @property {string} levelLabel 這次查詢的到院後檢傷分級（例：`第1級`）
 * @property {Record<string, string>[]} mainRows 詳細報表一的資料列
 * @property {Record<string, string>[]} patientRows 詳細報表二的資料列
 */

/**
 * @typedef {Object} MergedCase 兩張工作表合併後的一件案子
 * @property {string} caseKey 救護紀錄表單號（合併與去重都用它）
 * @property {string} levelLabel 來源查詢的檢傷等級
 * @property {Record<string, string>} main 詳細報表一的該列
 * @property {Record<string, string>} patient 詳細報表二的該列（沒有對應時為空物件）
 */

/**
 * @typedef {Object} DocumentTable 來文格式的表格內容
 * @property {string[]} headers 欄位標題（依設定順序）
 * @property {string[][]} rows 每一列的儲存格文字
 * @property {string[]} problems 需要人看一眼的情況（不會讓流程中止）
 */

/** 欄名比對用：把所有空白（含換行）拿掉再比。匯出檔的欄名裡有換行，例如「受傷機轉(因交通事故)」。 */
function normalizeHeader(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/** 儲存格轉字串：去掉前後空白，內部換行壓成一個空白。 */
function toText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 欄位存在與否（不取值），用來在核對前先確認結構。 */
export function hasColumn(row, columnName) {
  const wanted = normalizeHeader(columnName);
  return Object.keys(row).some((header) => normalizeHeader(header) === wanted);
}

/**
 * 依欄名取值，欄名以「去掉空白」後比對。
 *
 * 找不到欄位時直接中止：那代表匯出檔結構變了，繼續跑只會產出一份少了整欄的公文。
 * 錯誤訊息只列欄名（檔案結構，非個資），方便對照系統改了什麼。
 *
 * @param {Record<string, string>} row
 * @param {string} columnName
 * @param {string} [sheetLabel] 供錯誤訊息顯示的工作表名稱
 * @returns {string}
 */
export function readColumn(row, columnName, sheetLabel = '') {
  const wanted = normalizeHeader(columnName);
  for (const [header, value] of Object.entries(row)) {
    if (normalizeHeader(header) === wanted) return toText(value);
  }
  throw new Error(
    `${sheetLabel ? `「${sheetLabel}」` : ''}找不到欄位「${columnName}」。` +
      `實際欄名有：${Object.keys(row).join('、')}`,
  );
}

/**
 * 把系統的日期字串轉成民國格式 `115/08/01`（使用者 2026-09-01 指定的來文寫法）。
 *
 * 匯出檔的值長這樣：`2026/08/01 05:05:03`。時間不放進公文，只留日期。
 *
 * @param {string} text
 * @returns {string} 認不出格式時原樣回傳，由呼叫端決定要不要提醒
 */
export function toRocDate(text) {
  const matched = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(toText(text));
  if (!matched) return toText(text);
  const [, year, month, day] = matched;
  const rocYear = Number(year) - 1911;
  if (rocYear <= 0) return toText(text);
  return `${rocYear}/${String(Number(month)).padStart(2, '0')}/${String(Number(day)).padStart(2, '0')}`;
}

/**
 * 解析案發時間供排序用。
 * 讀不出來的回傳 null——排序時排到最後，並在問題列提醒，不會默默亂序。
 *
 * @param {string} text
 * @returns {Date|null}
 */
export function parseCaseTime(text) {
  const matched = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(toText(text));
  if (!matched) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = matched;
  const date = new Date(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 查證一份匯出檔真的是「我們設定的那些條件」查出來的。
 *
 * 這一步不是形式：查詢頁上有兩組長得一模一樣的受傷機轉勾選欄（`_scar` 與 `_scarSub`），
 * 到院前／到院後檢傷分級的下拉也長得一樣，選錯了畫面完全不會抗議，
 * 只會安靜地產出一份條件不對的名單。逐列回頭核對是唯一看得出來的方法。
 *
 * @param {Record<string, string>[]} mainRows 詳細報表一的資料列
 * @param {{key: string, column: string, expected: string, label: string}[]} expectations
 * @returns {{key: string, column: string, expected: string, label: string, badCount: number}[]}
 *   核對不過的條件；空陣列代表整份都對
 */
export function verifyExportRows(mainRows, expectations) {
  if (mainRows.length === 0) return []; // 沒有案件就沒得核對。
  const failed = [];
  for (const expectation of expectations) {
    if (!hasColumn(mainRows[0], expectation.column)) {
      failed.push({ ...expectation, badCount: mainRows.length });
      continue;
    }
    const badCount = mainRows.filter(
      (row) => readColumn(row, expectation.column) !== expectation.expected,
    ).length;
    if (badCount > 0) failed.push({ ...expectation, badCount });
  }
  return failed;
}

/**
 * 合併兩張工作表，並把多個檢傷等級的查詢結果串成一份名單。
 *
 * @param {SheetPair[]} sheetPairs 每個檢傷等級一組
 * @param {string} joinKeyColumn 串接用的欄名（救護紀錄表單號）
 * @returns {{cases: MergedCase[], problems: string[]}}
 */
export function mergeSheetPairs(sheetPairs, joinKeyColumn) {
  /** @type {Map<string, MergedCase>} */
  const byKey = new Map();
  const problems = [];

  for (const pair of sheetPairs) {
    /** @type {Map<string, Record<string, string>>} */
    const patientByKey = new Map();
    for (const row of pair.patientRows) {
      const key = readColumn(row, joinKeyColumn, '詳細報表二');
      if (!key) continue;
      if (patientByKey.has(key)) {
        problems.push(`${pair.levelLabel}：詳細報表二有兩列的${joinKeyColumn}相同，只取第一列`);
        continue;
      }
      patientByKey.set(key, row);
    }

    for (const row of pair.mainRows) {
      const key = readColumn(row, joinKeyColumn, '詳細報表一');
      if (!key) {
        problems.push(`${pair.levelLabel}：詳細報表一有一列沒有${joinKeyColumn}，已略過`);
        continue;
      }
      if (byKey.has(key)) {
        problems.push(`${byKey.get(key).levelLabel}與${pair.levelLabel}出現同一件案子，只算一次`);
        continue;
      }
      const patient = patientByKey.get(key);
      if (!patient) {
        problems.push(`${pair.levelLabel}：有一件案子在詳細報表二找不到對應資料，姓名與五級分類會是空的`);
      }
      byKey.set(key, {
        caseKey: key,
        levelLabel: pair.levelLabel,
        main: row,
        patient: patient ?? {},
      });
    }
  }

  return { cases: [...byKey.values()], problems };
}

/**
 * 依設定的欄位對應，產出來文格式的表格內容。
 *
 * 欄位對應放在 config（配置驅動）：來文要加一欄、或系統改了欄名，都只改設定。
 *
 * @param {MergedCase[]} cases
 * @param {readonly {title: string, source?: 'serial'|'blank', sheet?: 'main'|'patient',
 *   column?: string, transform?: 'rocDate'}[]} columnMap
 * @param {string} dateColumn 排序用的日期欄（詳細報表一的欄名）
 * @returns {DocumentTable}
 */
export function buildDocumentTable(cases, columnMap, dateColumn) {
  const problems = [];

  const withTime = cases.map((item) => {
    const raw = readColumn(item.main, dateColumn, '詳細報表一');
    const occurredAt = parseCaseTime(raw);
    if (!occurredAt) {
      problems.push(`有一件案子的「${dateColumn}」讀不出日期（值：${raw || '空白'}），排在最後`);
    }
    return { item, occurredAt };
  });

  // 依案發時間由早到晚；讀不出時間的排最後，同時間再依單號，確保每次跑出來順序一致。
  withTime.sort((left, right) => {
    const leftTime = left.occurredAt ? left.occurredAt.getTime() : Number.POSITIVE_INFINITY;
    const rightTime = right.occurredAt ? right.occurredAt.getTime() : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.item.caseKey.localeCompare(right.item.caseKey);
  });

  const rows = withTime.map(({ item }, index) =>
    columnMap.map((column) => {
      if (column.source === 'serial') return String(index + 1);
      if (column.source === 'blank') return '';
      const fromPatient = column.sheet === 'patient';
      const sourceRow = fromPatient ? item.patient : item.main;
      // 詳細報表二沒有對應列時（上游已提醒過）留白，不要讓整份產出失敗。
      if (fromPatient && Object.keys(sourceRow).length === 0) return '';
      const value = readColumn(sourceRow, column.column, fromPatient ? '詳細報表二' : '詳細報表一');
      return column.transform === 'rocDate' ? toRocDate(value) : value;
    }),
  );

  return { headers: columnMap.map((column) => column.title), rows, problems };
}

/**
 * 數出「需要人看一眼」的欄位空白情形（姓名不詳、沒有身分證字號）。
 *
 * 這些是真實資料本來就有的情況（無主病患、外籍人士），不是程式出錯，
 * 但公文送出去前應該知道有幾件，故單獨數出來。
 *
 * @param {DocumentTable} table
 * @param {{nameTitle: string, idTitle: string, unknownNameText: string}} settings
 * @returns {{unknownName: number, missingId: number}}
 */
export function countIncompleteIdentities(table, settings) {
  const nameIndex = table.headers.indexOf(settings.nameTitle);
  const idIndex = table.headers.indexOf(settings.idTitle);
  let unknownName = 0;
  let missingId = 0;
  for (const row of table.rows) {
    const name = nameIndex >= 0 ? row[nameIndex] : '';
    const id = idIndex >= 0 ? row[idIndex] : '';
    if (!name || name === settings.unknownNameText) unknownName += 1;
    if (!id) missingId += 1;
  }
  return { unknownName, missingId };
}
