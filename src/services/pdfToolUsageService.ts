/**
 * PDF 工具使用紀錄：寫入（每次下載一筆）、訂閱近 30 天、刪除過期紀錄。不依賴 React。
 *
 * 權限由 Firestore Security Rules 強制：
 * - 已核准的帳號（三種角色都是）可以新增「自己的」紀錄，欄位與型別固定、時間必須是伺服器時間
 * - 只有管理員讀得到、刪得掉；任何人都不能修改
 * **不記檔名**（見 types/pdfToolUsage.ts）。
 */
import {
  addDoc,
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import { PDF_USAGE_CONFIG } from '../config/pdfTools';
import type { AppUser } from '../types/user';
import type { PdfToolUsage, PdfUsageEntry } from '../types/pdfToolUsage';

const usageCollection = () => collection(db, COLLECTIONS.pdfToolUsage);

/** 保留期限的起點（現在往前 retentionDays 天）。 */
function retentionCutoff(): Timestamp {
  return Timestamp.fromMillis(Date.now() - PDF_USAGE_CONFIG.retentionDays * 24 * 60 * 60 * 1000);
}

function mapUsage(snapshot: QueryDocumentSnapshot<DocumentData>): PdfToolUsage {
  const data = snapshot.data();
  const usedAt = data.usedAt as Timestamp | null | undefined;
  return {
    id: snapshot.id,
    uid: data.uid ?? '',
    userName: data.userName ?? '',
    email: data.email ?? '',
    action: data.action ?? 'downloadAll',
    pageCount: data.pageCount ?? 0,
    fileCount: data.fileCount ?? 0,
    sourceCount: data.sourceCount ?? 0,
    markedPages: data.markedPages ?? 0,
    // 剛寫入、伺服器時間還沒回來時是 null，先用現在時間顯示。
    usedAt: usedAt ? usedAt.toDate().toISOString() : new Date().toISOString(),
  };
}

/** 記一筆使用紀錄。失敗只記在主控台，不影響使用者下載（紀錄是附帶的，不能擋住正事）。 */
export async function recordPdfToolUsage(user: AppUser, entry: PdfUsageEntry): Promise<void> {
  try {
    await addDoc(usageCollection(), {
      uid: user.uid,
      userName: (user.displayName || user.email).slice(0, 100),
      email: user.email,
      ...entry,
      usedAt: serverTimestamp(),
    });
  } catch (error) {
    console.error('PDF 工具使用紀錄寫入失敗（pdfToolUsageService.recordPdfToolUsage）：', error);
  }
}

/** 訂閱保留期限內的紀錄（新的在前）；只有管理員讀得到。 */
export function subscribeRecentPdfToolUsage(
  onData: (records: PdfToolUsage[]) => void,
  onError: (message: string) => void,
): () => void {
  const recent = query(usageCollection(), where('usedAt', '>=', retentionCutoff()), orderBy('usedAt', 'desc'));
  return onSnapshot(
    recent,
    (snapshot) => onData(snapshot.docs.map(mapUsage)),
    (error) => {
      console.error('讀取 PDF 工具使用紀錄失敗（pdfToolUsageService.subscribeRecentPdfToolUsage）：', error);
      onError(`讀取使用紀錄失敗：${error.message}`);
    },
  );
}

/** 刪掉超過保留期限的紀錄（管理員打開使用紀錄時呼叫）；回傳刪了幾筆。 */
export async function deleteExpiredPdfToolUsage(): Promise<number> {
  try {
    const expired = await getDocs(
      query(usageCollection(), where('usedAt', '<', retentionCutoff()), limit(PDF_USAGE_CONFIG.cleanupBatchSize)),
    );
    if (expired.empty) return 0;
    const batch = writeBatch(db);
    expired.docs.forEach((snapshot) => batch.delete(snapshot.ref));
    await batch.commit();
    return expired.size;
  } catch (error) {
    console.error('刪除過期 PDF 工具使用紀錄失敗（pdfToolUsageService.deleteExpiredPdfToolUsage）：', error);
    return 0;
  }
}
