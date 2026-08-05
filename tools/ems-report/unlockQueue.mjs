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
      '尚未設定線上工單的登入帳號。請在 tools/ems-report/.env 補上：\n'
        + '  EMS_WEB_EMAIL=你在網頁系統的 email\n'
        + '  EMS_WEB_PASSWORD=該帳號的密碼\n'
        + '（要用「一般使用者」或「管理員」帳號；解鎖專用帳號沒有回寫結果的權限。'
        + '若你平常是用 Google 登入，請到網頁註冊一組 email/密碼帳號給這支程式用。）',
    );
  }
  return { config, email, password };
}

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
    const code = error?.code ?? '';
    const hint = code === 'auth/invalid-credential' || code === 'auth/wrong-password'
      ? 'email 或密碼不對，請檢查 tools/ems-report/.env 的 EMS_WEB_EMAIL／EMS_WEB_PASSWORD。'
      : `錯誤代碼：${code || error?.message || '未知'}`;
    throw new Error(`連線上工單失敗（unlockQueue.connectQueue）：${hint}`);
  }
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
