/**
 * 屬性（分類）業務邏輯：查詢、建立、改名、排序、刪除、預設屬性建立。
 * 不依賴 React。權限由 Firestore Security Rules 強制（僅 ownerUid 本人可存取）。
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS, DEFAULT_CATEGORIES } from '../config/constants';
import type { Category } from '../types/category';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 將 Firestore 文件轉為強型別 Category。 */
function mapCategory(snapshot: QueryDocumentSnapshot<DocumentData>): Category {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name ?? '',
    sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : 0,
    ownerUid: data.ownerUid ?? '',
    createdAt: toIso(data.createdAt),
  };
}

/** 依 sortOrder（其次 createdAt）排序。 */
function bySortOrder(a: Category, b: Category): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return (a.createdAt || '').localeCompare(b.createdAt || '');
}

/**
 * 訂閱目前使用者的屬性清單（即時更新）。排序於用戶端完成，不需複合索引。
 * @returns 取消訂閱函式
 */
export function subscribeCategories(
  ownerUid: string,
  onData: (categories: Category[]) => void,
  onError: (error: Error) => void,
): () => void {
  const categoriesQuery = query(
    collection(db, COLLECTIONS.categories),
    where('ownerUid', '==', ownerUid),
  );
  return onSnapshot(
    categoriesQuery,
    (snapshot) => onData(snapshot.docs.map(mapCategory).sort(bySortOrder)),
    (error) => onError(new Error(`讀取屬性失敗（categoryService.subscribeCategories）：${error.message}`)),
  );
}

/**
 * 首次登入時建立預設屬性（採購、系統、其他）。
 * 若使用者已有任何屬性則不動作，避免重複建立。
 */
export async function ensureDefaultCategories(ownerUid: string): Promise<void> {
  try {
    const existing = await getDocs(
      query(collection(db, COLLECTIONS.categories), where('ownerUid', '==', ownerUid)),
    );
    if (!existing.empty) return;
    const batch = writeBatch(db);
    DEFAULT_CATEGORIES.forEach((name, index) => {
      const ref = doc(collection(db, COLLECTIONS.categories));
      batch.set(ref, { name, sortOrder: index, ownerUid, createdAt: serverTimestamp() });
    });
    await batch.commit();
  } catch (error) {
    throw new Error(
      `建立預設屬性失敗（categoryService.ensureDefaultCategories）：${(error as Error).message}`,
    );
  }
}

/** 新增屬性；sortOrder 由呼叫端算好（通常是現有最大值 + 1）。 */
export async function createCategory(
  name: string,
  sortOrder: number,
  ownerUid: string,
): Promise<string> {
  try {
    const created = await addDoc(collection(db, COLLECTIONS.categories), {
      name,
      sortOrder,
      ownerUid,
      createdAt: serverTimestamp(),
    });
    return created.id;
  } catch (error) {
    throw new Error(`新增屬性失敗（categoryService.createCategory）：${(error as Error).message}`);
  }
}

/** 修改屬性名稱。 */
export async function renameCategory(categoryId: string, name: string): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.categories, categoryId), { name });
  } catch (error) {
    throw new Error(`改名失敗（categoryService.renameCategory）：${(error as Error).message}`);
  }
}

/**
 * 依給定的屬性 ID 順序批次重寫 sortOrder（供拖曳排序）。
 * 傳入的陣列即為期望的顯示順序，每筆的 sortOrder 會被設為其索引（0..n-1）。
 * @param orderedIds 依目標順序排列的屬性 ID 陣列
 */
export async function reorderCategories(orderedIds: string[]): Promise<void> {
  try {
    const batch = writeBatch(db);
    orderedIds.forEach((categoryId, index) => {
      batch.update(doc(db, COLLECTIONS.categories, categoryId), { sortOrder: index });
    });
    await batch.commit();
  } catch (error) {
    throw new Error(`排序失敗（categoryService.reorderCategories）：${(error as Error).message}`);
  }
}

/** 計算某屬性目前被幾筆業務使用（刪除前檢查）。 */
export async function countTasksInCategory(categoryId: string, ownerUid: string): Promise<number> {
  try {
    const snapshot = await getDocs(
      query(
        collection(db, COLLECTIONS.tasks),
        where('ownerUid', '==', ownerUid),
        where('categoryId', '==', categoryId),
      ),
    );
    return snapshot.size;
  } catch (error) {
    throw new Error(
      `檢查屬性使用數失敗（categoryService.countTasksInCategory）：${(error as Error).message}`,
    );
  }
}

/**
 * 將某屬性底下的所有業務批次轉移到另一個屬性。
 * 於刪除仍被使用的屬性前呼叫。
 */
export async function reassignTasksCategory(
  fromCategoryId: string,
  toCategoryId: string,
  ownerUid: string,
): Promise<void> {
  try {
    const snapshot = await getDocs(
      query(
        collection(db, COLLECTIONS.tasks),
        where('ownerUid', '==', ownerUid),
        where('categoryId', '==', fromCategoryId),
      ),
    );
    if (snapshot.empty) return;
    const batch = writeBatch(db);
    snapshot.docs.forEach((taskDoc) => {
      batch.update(taskDoc.ref, { categoryId: toCategoryId, updatedAt: serverTimestamp() });
    });
    await batch.commit();
  } catch (error) {
    throw new Error(
      `轉移業務屬性失敗（categoryService.reassignTasksCategory）：${(error as Error).message}`,
    );
  }
}

/** 刪除屬性（呼叫端須先確保沒有業務仍在使用，或已完成轉移）。 */
export async function deleteCategory(categoryId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, COLLECTIONS.categories, categoryId));
  } catch (error) {
    throw new Error(`刪除屬性失敗（categoryService.deleteCategory）：${(error as Error).message}`);
  }
}
