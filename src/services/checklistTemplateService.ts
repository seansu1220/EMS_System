/**
 * 待辦公版（範本）業務邏輯：查詢、建立、改名、更新項目、刪除。
 * 不依賴 React。
 * 權限由 Firestore Security Rules 強制：公版為全體已核准使用者共用（v1.8 起）。
 * `ownerUid` 欄位語意為「建立者」，不再用於資料隔離。
 * 排序於用戶端完成（依名稱），不需複合索引。
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import type { ChecklistTemplate, ChecklistTemplateItem } from '../types/checklistTemplate';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 公版項目依 sortOrder 由小到大（缺漏時以索引遞補）。 */
function mapTemplateItems(raw: unknown): ChecklistTemplateItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as ChecklistTemplateItem[])
    .map((item, index) => ({
      id: item.id ?? crypto.randomUUID(),
      content: item.content ?? '',
      sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : index,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** 將 Firestore 文件轉為強型別 ChecklistTemplate。 */
function mapTemplate(snapshot: QueryDocumentSnapshot<DocumentData>): ChecklistTemplate {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    name: data.name ?? '',
    items: mapTemplateItems(data.items),
    ownerUid: data.ownerUid ?? '',
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}

/** 由內容字串陣列組出公版項目（sortOrder 依陣列順序 0..n-1）。 */
export function buildTemplateItems(contents: string[]): ChecklistTemplateItem[] {
  return contents.map((content, index) => ({
    id: crypto.randomUUID(),
    content,
    sortOrder: index,
  }));
}

/**
 * 訂閱待辦公版清單（即時更新，依名稱排序；全體已核准使用者共用）。
 * @returns 取消訂閱函式
 */
export function subscribeChecklistTemplates(
  onData: (templates: ChecklistTemplate[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COLLECTIONS.checklistTemplates),
    (snapshot) =>
      onData(
        snapshot.docs
          .map(mapTemplate)
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
      ),
    (error) =>
      onError(
        new Error(
          `讀取待辦公版失敗（checklistTemplateService.subscribeChecklistTemplates）：${error.message}`,
        ),
      ),
  );
}

/** 建立公版（名稱 + 項目內容清單；內容可為空陣列，之後再於公版管理頁補上）。 */
export async function createChecklistTemplate(
  name: string,
  contents: string[],
  ownerUid: string,
): Promise<string> {
  try {
    const created = await addDoc(collection(db, COLLECTIONS.checklistTemplates), {
      name,
      items: buildTemplateItems(contents),
      ownerUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return created.id;
  } catch (error) {
    throw new Error(
      `建立待辦公版失敗（checklistTemplateService.createChecklistTemplate）：${(error as Error).message}`,
    );
  }
}

/** 修改公版名稱。 */
export async function renameChecklistTemplate(templateId: string, name: string): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.checklistTemplates, templateId), {
      name,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(
      `公版改名失敗（checklistTemplateService.renameChecklistTemplate）：${(error as Error).message}`,
    );
  }
}

/**
 * 以整份項目陣列覆寫公版內容（新增/刪除/排序皆走此函式）。
 * 寫入前重編 sortOrder 為 0..n-1，確保順序連續。
 */
export async function updateChecklistTemplateItems(
  templateId: string,
  items: ChecklistTemplateItem[],
): Promise<void> {
  try {
    const normalized = items.map((item, index) => ({ ...item, sortOrder: index }));
    await updateDoc(doc(db, COLLECTIONS.checklistTemplates, templateId), {
      items: normalized,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(
      `更新公版項目失敗（checklistTemplateService.updateChecklistTemplateItems）：${(error as Error).message}`,
    );
  }
}

/** 刪除公版（不影響已套用到業務上的待辦事項）。 */
export async function deleteChecklistTemplate(templateId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, COLLECTIONS.checklistTemplates, templateId));
  } catch (error) {
    throw new Error(
      `刪除待辦公版失敗（checklistTemplateService.deleteChecklistTemplate）：${(error as Error).message}`,
    );
  }
}
