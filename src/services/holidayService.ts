/**
 * 國定假日（辦公日曆表）的資料存取。不依賴 React。
 *
 * Firestore 結構：`holidays/{西元年}`，一份文件就是一年的例外清單。
 * 以年份當文件 ID，重複匯入同一年會直接覆蓋，不會留下兩份互相打架的資料。
 * 權限由 Firestore Security Rules 強制：已核准者可讀、僅管理員可寫。
 */
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import type { HolidayCalendar, HolidayEntry } from '../types/holiday';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 將未知型別的陣列欄位轉為 HolidayEntry[]（防止舊資料或手動編輯造成的缺欄位）。 */
function toEntries(value: unknown): HolidayEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is DocumentData => typeof item === 'object' && item !== null)
    .map((item) => ({ date: String(item.date ?? ''), name: String(item.name ?? '') }))
    .filter((entry) => entry.date !== '');
}

/** 將 Firestore 文件轉為強型別 HolidayCalendar。 */
function mapCalendar(snapshot: QueryDocumentSnapshot<DocumentData>): HolidayCalendar {
  const data = snapshot.data();
  return {
    year: typeof data.year === 'number' ? data.year : Number(snapshot.id),
    holidays: toEntries(data.holidays),
    workdays: toEntries(data.workdays),
    offDayCount: typeof data.offDayCount === 'number' ? data.offDayCount : 0,
    source: 'imported',
    updatedAt: toIso(data.updatedAt),
  };
}

/**
 * 訂閱已匯入的假日清單（即時更新，全體共用）。排序於用戶端完成。
 * @returns 取消訂閱函式
 */
export function subscribeHolidayCalendars(
  onData: (calendars: HolidayCalendar[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COLLECTIONS.holidays),
    (snapshot) => onData(snapshot.docs.map(mapCalendar).sort((a, b) => a.year - b.year)),
    (error) =>
      onError(
        new Error(`讀取假日清單失敗（holidayService.subscribeHolidayCalendars）：${error.message}`),
      ),
  );
}

/**
 * 批次寫入（覆蓋）多個年度的假日清單。
 * @param calendars 解析完成的年度清單
 * @param updatedBy 操作者 uid（記錄用）
 */
export async function saveHolidayCalendars(
  calendars: readonly HolidayCalendar[],
  updatedBy: string,
): Promise<void> {
  if (calendars.length === 0) return;
  try {
    const batch = writeBatch(db);
    for (const calendar of calendars) {
      batch.set(doc(db, COLLECTIONS.holidays, String(calendar.year)), {
        year: calendar.year,
        holidays: calendar.holidays,
        workdays: calendar.workdays,
        offDayCount: calendar.offDayCount,
        updatedBy,
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (error) {
    throw new Error(
      `匯入假日清單失敗（holidayService.saveHolidayCalendars）：${(error as Error).message}`,
    );
  }
}

/** 刪除某年度已匯入的清單（該年份會回到程式內建版本，或退回只扣週末）。 */
export async function deleteHolidayCalendar(year: number): Promise<void> {
  try {
    await deleteDoc(doc(db, COLLECTIONS.holidays, String(year)));
  } catch (error) {
    throw new Error(
      `刪除假日清單失敗（holidayService.deleteHolidayCalendar）：${(error as Error).message}`,
    );
  }
}
