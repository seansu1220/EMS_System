/**
 * 測試用傷票的發號與領取紀錄。不依賴 React。
 *
 * 號碼是**全系統接續**的：A 領 10 張拿到 `H00T000 ~ H00T009`，下一個人領 2 張就是
 * `H00T010`、`H00T011`。另外**同一個單位每週最多領 20 張**（台灣時間週一起算）。
 *
 * 為了讓兩個人同時按也不會拿到同一批號碼、也不會一起衝破單位上限，
 * 「讀下一號與單位本週用量 → 往後推 → 寫領取紀錄」包在同一個 Firestore transaction 裡，
 * 安全規則再檢查一次三份文件對得起來（見 `firebase/firestore.rules` 的 triageTag 段落）。
 *
 * 號碼一旦發出就不回收（紙本傷票也是這樣，印壞了就作廢）。
 */
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import {
  TRIAGE_TAG_MAX_PER_REQUEST,
  TRIAGE_TAG_TOTAL,
} from '../config/triageTag';
import {
  formatTriageTagNumber,
  remainingTriageTags,
  triageTagWeekIndex,
  triageTagWeeklyLimitFor,
  validateTriageTagUnit,
} from '../lib/triageTagNumber';
import { isAdmin } from '../lib/permissions';
import type { AppUser } from '../types/user';
import type { TriageTagIssue } from '../types/triageTag';

/** 計數器只有一份文件。 */
const COUNTER_DOC_ID = 'main';

/** 單位週用量的文件 ID（安全規則用同樣的組法核對）。 */
function unitWeekDocId(weekIndex: number, unit: string): string {
  return `${weekIndex}_${unit}`;
}

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

function mapIssue(snapshot: QueryDocumentSnapshot<DocumentData>): TriageTagIssue {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    startSerial: Number(data.startSerial ?? 0),
    count: Number(data.count ?? 0),
    unit: data.unit ?? '',
    weekIndex: Number(data.weekIndex ?? 0),
    requestedBy: data.requestedBy ?? '',
    requestedByName: data.requestedByName ?? '',
    requestedAt: toIso(data.requestedAt),
  };
}

/**
 * 檢查要領的張數（純函式）。
 *
 * @param unitUsed 這個單位本週已經領了幾張
 * @param weeklyLimit 這個單位每週上限；null＝不限（管理員的救護科）
 * @returns 錯誤訊息；沒問題回傳 null
 */
export function validateTriageTagCount(
  count: number,
  nextSerial: number,
  unitUsed: number,
  weeklyLimit: number | null,
): string | null {
  if (!Number.isInteger(count) || count < 1) return '請輸入要領幾張（至少 1 張）。';
  if (count > TRIAGE_TAG_MAX_PER_REQUEST) {
    return `一次最多領 ${TRIAGE_TAG_MAX_PER_REQUEST} 張，要更多請分次領。`;
  }
  if (weeklyLimit !== null) {
    const unitRemaining = Math.max(0, weeklyLimit - unitUsed);
    if (count > unitRemaining) {
      return `同一單位每週最多 ${weeklyLimit} 張，本週已領 ${unitUsed} 張，最多還能領 ${unitRemaining} 張。`;
    }
  }
  const remaining = remainingTriageTags(nextSerial);
  if (count > remaining) return `號碼只剩 ${remaining} 張可以發（到 ${formatTriageTagNumber(TRIAGE_TAG_TOTAL - 1)} 為止）。`;
  return null;
}

/**
 * 領取一批傷票號碼（接續上一個人的號碼往下發，並計入單位本週用量）。
 *
 * @returns 這次拿到的起始流水號與張數
 * @throws 單位不在名單、張數不合法、超過單位每週上限、號碼不夠、或寫入失敗時
 */
export async function allocateTriageTags(
  user: AppUser,
  rawUnit: string,
  count: number,
): Promise<{ startSerial: number; count: number }> {
  const unit = rawUnit.trim();
  const unitProblem = validateTriageTagUnit(unit, isAdmin(user));
  if (unitProblem) throw new Error(unitProblem);
  const weekIndex = triageTagWeekIndex(new Date());
  const counterRef = doc(db, COLLECTIONS.triageTagCounter, COUNTER_DOC_ID);
  const usageRef = doc(db, COLLECTIONS.triageTagUnitWeeks, unitWeekDocId(weekIndex, unit));
  try {
    return await runTransaction(db, async (transaction) => {
      const counterSnapshot = await transaction.get(counterRef);
      const usageSnapshot = await transaction.get(usageRef);
      const startSerial = counterSnapshot.exists() ? Number(counterSnapshot.data().nextSerial ?? 0) : 0;
      const unitUsed = usageSnapshot.exists() ? Number(usageSnapshot.data().used ?? 0) : 0;
      const problem = validateTriageTagCount(count, startSerial, unitUsed, triageTagWeeklyLimitFor(unit));
      if (problem) throw new Error(problem);
      transaction.set(counterRef, { nextSerial: startSerial + count, updatedAt: serverTimestamp() });
      // lastStartSerial：安全規則靠它確認「這一張紀錄」真的有把用量加上去。
      transaction.set(usageRef, { unit, weekIndex, used: unitUsed + count, lastStartSerial: startSerial });
      // 文件 ID＝起始流水號：天生不重複，安全規則也靠它把三份文件對起來。
      transaction.set(doc(db, COLLECTIONS.triageTagIssues, String(startSerial)), {
        startSerial,
        count,
        unit,
        weekIndex,
        requestedBy: user.uid,
        requestedByName: user.displayName || user.email,
        requestedAt: serverTimestamp(),
      });
      return { startSerial, count };
    });
  } catch (error) {
    throw new Error(`領取傷票號碼失敗（triageTagService.allocateTriageTags）：${(error as Error).message}`);
  }
}

/**
 * 訂閱「下一個要發的流水號」（顯示從哪一號開始、還剩幾張）。
 * @returns 取消訂閱函式
 */
export function subscribeTriageTagNextSerial(
  onData: (nextSerial: number) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COLLECTIONS.triageTagCounter, COUNTER_DOC_ID),
    (snapshot) => onData(snapshot.exists() ? Number(snapshot.data().nextSerial ?? 0) : 0),
    (error) =>
      onError(new Error(`讀取傷票號碼進度失敗（triageTagService.subscribeTriageTagNextSerial）：${error.message}`)),
  );
}

/**
 * 訂閱某單位某一週已經領了幾張（輸入單位時即時顯示剩餘額度）。
 * @returns 取消訂閱函式
 */
export function subscribeTriageTagUnitUsage(
  unit: string,
  weekIndex: number,
  onData: (used: number) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COLLECTIONS.triageTagUnitWeeks, unitWeekDocId(weekIndex, unit)),
    (snapshot) => onData(snapshot.exists() ? Number(snapshot.data().used ?? 0) : 0),
    (error) =>
      onError(new Error(`讀取單位本週領取量失敗（triageTagService.subscribeTriageTagUnitUsage）：${error.message}`)),
  );
}

/**
 * 訂閱領取紀錄（新的排前面）。
 *
 * `onlyMine` 為 true 時只訂閱自己的——解鎖專用帳號的安全規則只准讀自己的，
 * 查詢沒帶條件會被直接拒絕（同解鎖工單）。
 * @returns 取消訂閱函式
 */
export function subscribeTriageTagIssues(
  options: { uid: string; onlyMine: boolean },
  onData: (issues: TriageTagIssue[]) => void,
  onError: (error: Error) => void,
): () => void {
  const base = collection(db, COLLECTIONS.triageTagIssues);
  const target = options.onlyMine ? query(base, where('requestedBy', '==', options.uid)) : query(base);
  return onSnapshot(
    target,
    (snapshot) => {
      const issues = snapshot.docs.map(mapIssue);
      issues.sort((left, right) => right.startSerial - left.startSerial);
      onData(issues);
    },
    (error) =>
      onError(new Error(`讀取傷票領取紀錄失敗（triageTagService.subscribeTriageTagIssues）：${error.message}`)),
  );
}
