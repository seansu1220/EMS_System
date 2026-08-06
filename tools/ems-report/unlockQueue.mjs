/**
 * 線上解鎖工單：本機這一端。
 *
 * 流程是「網頁提出申請 → **這支程式來拿** → 實際解鎖 → 結果回寫網頁」。
 * 網頁那一端在 `src/services/unlockRequestService.ts`，欄位定義在
 * `src/types/unlockRequest.ts`，兩邊改欄位要一起改。
 *
 * ⚠ 為什麼實際解鎖不能放在雲端跑：
 *   1. 目標系統每次登入都要**驗證碼**，而本專案的鐵則是由使用者本人辨識、不自動破解
 *   2. 放到 Cloud Functions 就得把救護系統的帳密存上雲，違反「帳密只從本機 .env 讀」
 *   因此雲端只當「信箱」，真正動手的永遠是這台電腦。
 *
 * ⚠ 個資原則：
 *   - 上雲的只有 TEMSIS（案件編號）、事由、申請人與結果說明，**沒有任何病患資料**
 *   - 救護系統的帳密與登入狀態一律留在本機，不會寫進 Firestore
 *   - 終端機與 last-run.log 仍一律只印 TEMSIS 末 4 碼
 */
import path from 'node:path';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { PATHS } from './config.mjs';
import { log } from './logger.mjs';

/** Firestore 集合名稱（與網頁端 `COLLECTIONS.unlockRequests` 一致）。 */
const COLLECTION = 'unlockRequests';

/**
 * 解鎖結果 → 工單狀態的對照（純函式，方便測試）。
 *
 * 只有三種結局要讓申請人看到：解開了、本來就沒鎖、需要人接手。
 * 「查無案件」「失敗」都併入 failed——對申請人來說都是「這筆沒處理成，看說明」。
 *
 * @param {string} status `UnlockOutcome.status`
 * @returns {'unlocked'|'noAction'|'failed'}
 */
export function toQueueStatus(status) {
  if (status === '已解鎖') return 'unlocked';
  if (status === '無需處理') return 'noAction';
  return 'failed';
}

/**
 * 讀取 Firebase 設定與登入帳號。
 *
 * - Firebase 專案設定取自**專案根目錄的 `.env`**（`VITE_FIREBASE_*`）。
 *   這些值本來就會被打包進公開的網頁檔案，不是機密，因此共用同一份免得兩邊不同步。
 * - 登入用的帳密取自 `tools/ems-report/.env`（已 gitignore），
 *   必須是**一般使用者或管理員**帳號——解鎖專用帳號依安全規則無法回寫結果。
 *
 * @returns {{config: Record<string,string>, email: string, password: string}}
 * @throws 設定不全時，訊息直接說明要去哪個檔案補什麼
 */
function readQueueSettings() {
  for (const envPath of [path.join(PATHS.toolDir, '.env'), path.join(PATHS.toolDir, '..', '..', '.env')]) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // 沒有這個檔案屬正常情況，用得到的變數缺了下面才會報錯。
    }
  }

  const config = {
    apiKey: process.env.VITE_FIREBASE_API_KEY ?? '',
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.VITE_FIREBASE_PROJECT_ID ?? '',
    appId: process.env.VITE_FIREBASE_APP_ID ?? '',
  };
  const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `讀不到 Firebase 設定（缺 ${missing.join('、')}）。`
        + '請確認專案根目錄的 .env 已依 .env.example 填妥（就是網頁前端在用的那一份）。',
    );
  }

  const email = (process.env.EMS_WEB_EMAIL ?? '').trim();
  const password = process.env.EMS_WEB_PASSWORD ?? '';
  if (!email || !password) {
    throw new Error(
      '尚未設定線上工單的登入帳號。請在 tools/ems-report/.env 補上 '
        + 'EMS_WEB_EMAIL 與 EMS_WEB_PASSWORD。\n'
        + `${SETUP_STEPS}`,
    );
  }
  return { config, email, password };
}

/**
 * 帳號怎麼來的四步驟。
 *
 * 使用者平常用 Google 登入，**Google 登入沒有密碼可以填**（那組密碼是 Google 的，
 * 本系統拿不到也不該拿），因此第一次設定時一定會卡在這裡（2026-08-06 實際卡到）。
 * 凡是與這組帳密有關的錯誤都把這段附上，不要只丟一句「登入失敗」。
 */
const SETUP_STEPS = [
  '',
  '用 Google 登入的話，請另外開一組專門給程式用的帳號（四步）：',
  '  1. 開 https://ems-system-su1220.web.app/register （建立新帳號那一頁，不要按 Google 登入）',
  '  2. 隨便填一組只給程式用的帳密。Email 建議用 Gmail 的 + 別名，',
  '     例如 你的帳號+unlock@gmail.com，信一樣會進你原本的信箱',
  '  3. 用你平常的 Google 帳號登入 → 使用者管理 → 把那個帳號**核准**，',
  '     角色維持「一般使用者」（解鎖專用帳號沒有回寫結果的權限）',
  '  4. 把帳密填進 tools/ems-report/.env 的 EMS_WEB_EMAIL／EMS_WEB_PASSWORD',
].join('\n');

/**
 * @typedef {Object} QueueSession
 * @property {import('firebase/firestore').Firestore} db
 * @property {string} displayName 登入者顯示名稱（會寫進工單的「由誰執行」）
 */

/**
 * 連上雲端工單（登入 Firebase）。
 *
 * @returns {Promise<QueueSession>}
 * @throws 設定不全或登入失敗時，訊息會說明是哪一種
 */
export async function connectQueue() {
  const { config, email, password } = readQueueSettings();
  const app = initializeApp(config, `unlock-queue-${Date.now()}`);
  const auth = getAuth(app);
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const displayName = credential.user.displayName || credential.user.email || '（未命名）';
    log.ok(`已連上線上工單（登入者：${displayName}）`);
    return { db: getFirestore(app), displayName };
  } catch (error) {
    throw new Error(`連線上工單失敗（unlockQueue.connectQueue）：${describeAuthError(error)}`);
  }
}

/** 把 Firebase 的登入錯誤碼翻成「該怎麼辦」。 */
function describeAuthError(error) {
  const code = error?.code ?? '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password'
    || code === 'auth/user-not-found' || code === 'auth/invalid-email') {
    return `email 或密碼不對（${code}）。\n`
      + '請檢查 tools/ems-report/.env 的 EMS_WEB_EMAIL／EMS_WEB_PASSWORD。\n'
      + '⚠ 用 Google 登入的帳號**沒有密碼可以填在這裡**——那組密碼是 Google 的。\n'
      + SETUP_STEPS;
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Firebase 專案沒有開啟「電子郵件/密碼」登入方式，'
      + '請到 Firebase 主控台 → Authentication → Sign-in method 啟用它。';
  }
  if (code === 'auth/too-many-requests') {
    return '嘗試次數過多，Firebase 暫時擋下了。請等幾分鐘再試。';
  }
  if (code === 'auth/network-request-failed') {
    return '連不上網路（或被防火牆擋下）。這一步需要連得到網際網路。';
  }
  return `錯誤代碼：${code || error?.message || '未知'}`;
}

/**
 * @typedef {Object} QueueRequest
 * @property {string} id 工單文件 ID
 * @property {string} temsis
 * @property {string} reason 申請事由
 * @property {string} requestedByName 申請人
 * @property {string} requestedAt 申請時間（ISO 字串或 Firestore Timestamp 轉出的字串）
 */

/** Firestore Timestamp / 字串 → 可排序的字串。 */
function toIso(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  return typeof value === 'string' ? value : '';
}

/**
 * 抓出所有待處理的工單（先送的先做）。
 *
 * 刻意在**開瀏覽器之前**呼叫：沒有待處理工單時就不必白登入一次救護系統。
 *
 * @param {QueueSession} session
 * @returns {Promise<QueueRequest[]>}
 */
export async function fetchPendingRequests(session) {
  try {
    const snapshot = await getDocs(
      query(collection(session.db, COLLECTION), where('status', '==', 'pending')),
    );
    const requests = snapshot.docs.map((item) => {
      const data = item.data();
      return {
        id: item.id,
        temsis: String(data.temsis ?? '').trim(),
        reason: data.reason ?? '',
        requestedByName: data.requestedByName ?? '',
        requestedAt: toIso(data.requestedAt),
      };
    });
    // 先送的先做（時間讀不到的排最後，不讓它插隊）。
    requests.sort((left, right) => (left.requestedAt || '9999').localeCompare(right.requestedAt || '9999'));
    return requests.filter((item) => item.temsis !== '');
  } catch (error) {
    // 登入成功卻讀不到，幾乎一定是帳號本身的權限問題，不是程式壞了。
    if (error?.code === 'permission-denied') {
      throw new Error(
        '讀取待處理工單被拒絕：這組帳號登入成功了，但沒有讀取工單的權限。兩個常見原因：\n'
          + '  1. 帳號還沒被核准 → 用你平常的帳號登入網頁 → 使用者管理 → 核准它\n'
          + '  2. 角色被設成「解鎖專用」→ 改成「一般使用者」'
          + '（解鎖專用只看得到自己送的工單，也不能回寫結果）',
      );
    }
    throw new Error(`讀取待處理工單失敗（unlockQueue.fetchPendingRequests）：${error.message}`);
  }
}

/**
 * 標記某張工單「處理中」，讓網頁上看得到進度。
 *
 * 失敗只警告不中斷：這只是進度顯示，不該因為它跑不動就不去解鎖。
 */
export async function markRunning(session, requestId) {
  try {
    await updateDoc(doc(session.db, COLLECTION, requestId), { status: 'running' });
  } catch (error) {
    log.warn(`更新工單狀態為「處理中」失敗（不影響解鎖）：${error.message}`);
  }
}

/**
 * 把解鎖結果回寫工單。
 *
 * @param {QueueSession} session
 * @param {string} requestId
 * @param {import('./unlock.mjs').UnlockOutcome} outcome
 * @returns {Promise<boolean>} 是否寫入成功
 */
export async function saveResult(session, requestId, outcome) {
  try {
    await updateDoc(doc(session.db, COLLECTION, requestId), {
      status: toQueueStatus(outcome.status),
      result: {
        caseDate: outcome.caseDate ?? null,
        vehicle: outcome.vehicle ?? null,
        squad: outcome.squad ?? null,
        detail: outcome.detail ?? '',
        processedAt: new Date().toISOString(),
        processedBy: session.displayName,
      },
    });
    return true;
  } catch (error) {
    // 這裡失敗代表「解鎖做了、但網頁上看不到結果」，必須講清楚，不能默默吞掉。
    log.warn(`結果回寫失敗，這一筆在網頁上會停在「處理中」：${error.message}`);
    return false;
  }
}
