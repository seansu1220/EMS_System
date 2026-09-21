/**
 * 上傳清單的**內容判讀**：這個檔案到底是不是 12 導程心電圖、
 * 那句備註到底算不算「補述原因」。
 *
 * 為什麼需要這一支（使用者 2026-09-21 提出的兩個實務問題）：
 *
 *   1. 有人把 12 導程心電圖用**「案件影音」**這個檔案類型傳上去。
 *      舊規則只認「檔案類型＝12導程心電圖」，這種一律判成「沒有 12 導程」，
 *      明明有做、也在到院前就傳了，分隊卻白白掉一件。
 *      → 把「案件影音」那幾列的檔案抓回來判讀內容。
 *
 *   2. 到院後才傳，但**備註欄寫了原因**的，使用者要當成有在到院前完成。
 *      → 判斷備註是不是人寫的補述，而不是機器自動填的樣板字。
 *
 * 設計原則：
 *   - **判讀規則全部是純函式**（輸入文字 → 輸出結論），可單獨測試；
 *     只有 `inspectMediaFile` 會碰網路。
 *   - **判不出來就明講判不出來**，絕不猜。照片（jpg/png）程式讀不出內容，
 *     一律列給使用者自己點開看（使用者 2026-09-21 選擇），
 *     硬猜的話兩種錯都會發生：把現場照片當成心電圖而灌水，
 *     或把心電圖照片漏掉而讓分隊掉一件。
 *
 * ⚠ 個資原則：檔案內容**只存在記憶體**，判讀完即丟——不落檔、不寫進 log、
 *   不印在終端機。對外只回傳「是不是心電圖」與一句判斷依據。
 *   檔案下載網址帶著案件資料夾編號，只能出現在 `out/internal/` 的內部清單。
 */
import { EKG } from './config.mjs';
import { extractPdfText } from './pdfText.mjs';

/**
 * 判讀結果的四種值，集中定義避免各處字串打錯。
 *
 * `unreadable` 與 `failed` 分得很清楚：前者是「這種檔案程式本來就讀不出內容」
 * （照片），後者是「本來讀得出來，但這次沒讀成」（網路、權限、檔案壞掉）。
 * 兩者要給使用者的話不一樣——前者請他點開看，後者請他重跑。
 */
export const MEDIA_KIND = {
  twelveLead: '12導程心電圖',
  notEcg: '不是心電圖',
  unreadable: '程式讀不出內容',
  failed: '讀取失敗',
};

/** 取副檔名（小寫、不含點）；沒有副檔名時回傳空字串。 */
export function fileExtension(fileName) {
  const name = String(fileName ?? '').trim();
  // 網址帶查詢字串時（`…/a.pdf?x=1`）先把它切掉，否則副檔名會變成 `pdf?x=1`。
  const withoutQuery = name.split(/[?#]/)[0];
  const lastDot = withoutQuery.lastIndexOf('.');
  if (lastDot < 0 || lastDot === withoutQuery.length - 1) return '';
  return withoutQuery.slice(lastDot + 1).toLowerCase();
}

/** 這一欄的值含有任一字樣（忽略空白與大小寫）。 */
function containsAny(value, markers) {
  const text = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  if (!text) return false;
  return markers.some((marker) => {
    const wanted = String(marker ?? '').replace(/\s+/g, '').toUpperCase();
    return wanted !== '' && text.includes(wanted);
  });
}

/**
 * 把上傳清單的每一列分成三堆。
 *
 * ⚠ **只看「檔案類型」欄的值**（使用者 2026-08-05 指正）。
 *   比對整列或比對備註的話，備註欄的「ZOLL12導程附檔上傳(JSON檔)」
 *   會讓檔案類型根本不是 12 導程的列也被算成有做。
 *
 * @param {import('./pageFinder.mjs').FileRow[]} rows
 * @param {typeof EKG.verify} [config]
 * @returns {{twelveLead: import('./pageFinder.mjs').FileRow[],
 *   media: import('./pageFinder.mjs').FileRow[],
 *   others: import('./pageFinder.mjs').FileRow[]}}
 */
export function classifyFileRows(rows, config = EKG.verify) {
  const twelveLead = [];
  const media = [];
  const others = [];
  for (const row of rows ?? []) {
    if (containsAny(row?.fileType, config.twelveLeadMarkers)) twelveLead.push(row);
    else if (containsAny(row?.fileType, config.mediaMarkers)) media.push(row);
    else others.push(row);
  }
  return { twelveLead, media, others };
}

/**
 * 這段備註算不算「人工補述的原因」。
 *
 * 判斷方式是**先把已知的機器樣板字刪掉，再看剩下幾個字**：
 *   - `ZOLL介接心電圖`　　　　　　　　　　　→ 刪完什麼都不剩，不算補述
 *   - `ZOLL介接心電圖，現場無訊號延後上傳`　→ 刪完還剩一句話，算補述
 *
 * 不這樣做的話只有兩條路，兩條都不對：要求備註完全等於樣板字，
 * 機器字後面接一句人工補述就被當成樣板而漏掉；或只要非空就算，
 * 那所有 ZOLL 自動上傳又到院後才傳的案件全部補進分子，「到院後」這個判定等於失效。
 *
 * @param {string} text 備註原文
 * @param {{minLength: number, autoPatterns: string[]}} [config]
 * @param {{trustAsHuman?: boolean}} [options]
 *   `trustAsHuman`＝這一列的檔案類型是「案件影音」，代表是人自己上傳、自己打的字
 *   （使用者 2026-09-21 說明：設備自動傳的一律落在「12導程心電圖」那個類型），
 *   因此不套用機器樣板過濾，只看長度。
 * @returns {boolean}
 */
export function isMeaningfulRemark(text, config = EKG.verify.remark, options = {}) {
  const original = String(text ?? '').trim();
  if (!original) return false;

  let residue = original;
  if (!options.trustAsHuman) {
    for (const pattern of config.autoPatterns ?? []) {
      if (!pattern) continue;
      // 逐一刪去：樣板字可能重複出現（有人一次傳好幾個檔案再把備註貼在一起）。
      residue = residue.split(pattern).join('');
    }
  }
  // 刪完只剩標點、括號、空白的，等於沒寫。
  residue = residue.replace(/[\s　()（）,，、。.;；:：\-—_/／\\|｜]+/g, '');
  return residue.length >= config.minLength;
}

/**
 * 這段文字看起來是不是 12 導程心電圖的內容。
 *
 * 兩條路任一成立即可：
 *   1. 直接寫著「12導程」「12-Lead」這類字樣（`strongMarkers`）
 *   2. 湊滿 `minLeadMarkers` 個不同的**導程名稱**（aVR、V1…V6）
 *
 * 第 2 條要求湊滿好幾個，是因為單獨一個完全不足以斷定：
 * `V1` 可能是版本號、`III` 可能是頁碼。四個不同的導程名稱同時出現在
 * 一份非心電圖的檔案裡，實務上不會發生。
 *
 * @param {string} text
 * @param {typeof EKG.verify.media} [config]
 * @returns {{is: boolean, why: string}}
 */
export function looksLikeTwelveLead(text, config = EKG.verify.media) {
  const raw = String(text ?? '').toUpperCase();
  if (!raw.trim()) return { is: false, why: '檔案裡抽不出任何文字' };
  // 「12 LEAD」中間的空白要不要算，兩種寫法都會遇到，因此兩種形式都比一次。
  const squeezed = raw.replace(/\s+/g, '');

  for (const marker of config.strongMarkers ?? []) {
    const wanted = String(marker ?? '').toUpperCase();
    if (!wanted) continue;
    if (raw.includes(wanted) || squeezed.includes(wanted.replace(/\s+/g, ''))) {
      return { is: true, why: `檔案內容出現「${marker}」` };
    }
  }

  const hits = (config.leadMarkers ?? []).filter((marker) => {
    const wanted = String(marker ?? '').toUpperCase();
    return wanted !== '' && squeezed.includes(wanted);
  });
  if (hits.length >= config.minLeadMarkers) {
    return { is: true, why: `檔案內容出現 ${hits.length} 個導程名稱（${hits.join('、')}）` };
  }
  return {
    is: false,
    why: hits.length > 0
      ? `只出現 ${hits.length} 個導程名稱（${hits.join('、')}），不足 ${config.minLeadMarkers} 個，不能斷定`
      : '檔案內容沒有任何 12 導程或導程名稱的字樣',
  };
}

/**
 * 依副檔名決定「這個檔案要怎麼處理」。
 *
 * 抽成純函式是為了能單獨測——這是整段判讀的第一個岔路，
 * 走錯的話後面全錯（把影片抓回來解析、把照片硬判成不是心電圖）。
 *
 * @param {string} fileName
 * @param {typeof EKG.verify.media} [config]
 * @returns {'text'|'image'|'skip'}
 */
export function mediaHandling(fileName, config = EKG.verify.media) {
  const extension = fileExtension(fileName);
  if (config.textExtensions.includes(extension)) return 'text';
  if (config.imageExtensions.includes(extension)) return 'image';
  if (config.skipExtensions.includes(extension)) return 'skip';
  // 沒見過的副檔名當作讀得出文字來試一次：試了最多是判成「不是心電圖」，
  // 直接放棄則是永遠漏掉一種新格式。
  return 'text';
}

/**
 * 把抓回來的位元組轉成可判讀的文字。
 *
 * PDF 走 pdfjs 抽文字；其餘（JSON、XML、純文字）直接當 UTF-8 讀。
 * 二進位檔讀出來會是亂碼，但亂碼裡不會湊出四個導程名稱，
 * 因此結論仍然是「不是心電圖」，不會誤判。
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {string} fileName
 * @returns {Promise<string>}
 */
export async function bytesToText(bytes, fileName) {
  if (fileExtension(fileName) === 'pdf') return extractPdfText(bytes, { maxPages: 3 });
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 抓一個檔案回來判讀內容。**這是本檔唯一碰網路的函式。**
 *
 * 用 Playwright 的 `context.request`（與瀏覽器共用登入 Cookie）直接 GET 檔案網址，
 * 而**不是**去點畫面上的連結：點連結要同時應付彈出視窗、下載事件、
 * Chrome 內建 PDF 閱讀器三種情形，慢又容易卡住（第 2 章為了救護紀錄表已經踩過一輪）。
 *
 * ⚠ 個資：位元組與抽出來的文字都只存在這個函式裡，回傳前即丟棄。
 *
 * @param {import('playwright-core').APIRequestContext} request `session.context.request`
 * @param {{text: string, href: string}} link 檔案連結（絕對網址）
 * @param {typeof EKG.verify.media} [config]
 * @returns {Promise<{kind: string, why: string}>}
 */
export async function inspectMediaFile(request, link, config = EKG.verify.media) {
  const fileName = link?.text || link?.href || '';
  const handling = mediaHandling(fileName, config);
  if (handling === 'image') {
    return {
      kind: MEDIA_KIND.unreadable,
      why: `${fileExtension(fileName) || '無副檔名'} 是圖片，程式讀不出內容，請自己點開看`,
    };
  }
  if (handling === 'skip') {
    return { kind: MEDIA_KIND.notEcg, why: `${fileExtension(fileName)} 是影音或壓縮檔，不是心電圖` };
  }
  if (!link?.href) return { kind: MEDIA_KIND.failed, why: '這一列的檔案連結沒有網址' };

  let response;
  try {
    response = await request.get(link.href, { timeout: config.fetchTimeoutMs });
  } catch (error) {
    return {
      kind: MEDIA_KIND.failed,
      why: `抓檔案時連線失敗：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok()) {
    return { kind: MEDIA_KIND.failed, why: `抓檔案時系統回 HTTP ${response.status()}` };
  }

  // 先看長度再決定要不要整個讀進記憶體：有人把幾百 MB 的影片改成 .dat 傳上來，
  // 整個讀進來會讓 Node 直接爆掉，而那種檔案本來就不會是心電圖。
  const declaredLength = Number(response.headers()['content-length'] ?? '0');
  if (declaredLength > config.maxBytes) {
    return {
      kind: MEDIA_KIND.notEcg,
      why: `檔案 ${Math.round(declaredLength / 1024 / 1024)} MB，超過 ${Math.round(config.maxBytes / 1024 / 1024)} MB 上限，當成影音不判讀`,
    };
  }

  try {
    const bytes = await response.body();
    if (bytes.length > config.maxBytes) {
      return { kind: MEDIA_KIND.notEcg, why: '檔案超過大小上限，當成影音不判讀' };
    }
    const text = await bytesToText(bytes, fileName);
    const verdict = looksLikeTwelveLead(text, config);
    return { kind: verdict.is ? MEDIA_KIND.twelveLead : MEDIA_KIND.notEcg, why: verdict.why };
  } catch (error) {
    // 讀不動不代表不是心電圖（可能是加密 PDF、壞檔）。**回「讀取失敗」而不是「不是」**，
    // 這樣它會進待人工確認清單，而不是默默被當成沒做。
    return {
      kind: MEDIA_KIND.failed,
      why: `檔案抓回來了但解析不了：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
