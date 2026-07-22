/**
 * 業務（task）業務邏輯：查詢、新增、更新、刪除、進度與待辦管理、完成/解除。
 * 不依賴 React。權限由 Firestore Security Rules 強制（僅 ownerUid 本人可存取）。
 * 清單排序/篩選於用戶端（見 lib/taskLogic.ts）完成，不需複合索引。
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { COLLECTIONS } from '../config/constants';
import type { ChecklistItem, ProgressEntry, Task, TaskDraft } from '../types/task';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/**
 * 由文件 ID 與原始資料組出強型別 Task。
 * 對舊資料（可能仍有 status/priority、尚無 checklistItems/completed 等欄位）提供預設值相容：
 * completed 取 data.completed ?? (data.status === 'done')。
 */
function mapTaskData(id: string, data: DocumentData): Task {
  return {
    id,
    title: data.title ?? '',
    categoryId: data.categoryId ?? '',
    description: data.description ?? '',
    deadline: data.deadline ?? null,
    progressEntries: Array.isArray(data.progressEntries)
      ? (data.progressEntries as ProgressEntry[])
      : [],
    checklistItems: Array.isArray(data.checklistItems)
      ? (data.checklistItems as ChecklistItem[])
      : [],
    note: data.note ?? '',
    completed: data.completed ?? data.status === 'done',
    completionDate: data.completionDate ?? null,
    completionNote: data.completionNote ?? '',
    ownerUid: data.ownerUid ?? '',
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    completedAt: data.completedAt ? toIso(data.completedAt) : null,
  };
}

/** 將 Firestore 文件轉為強型別 Task。 */
function mapTask(snapshot: QueryDocumentSnapshot<DocumentData>): Task {
  return mapTaskData(snapshot.id, snapshot.data());
}

/**
 * 訂閱目前使用者的全部業務（即時更新）。排序交由呼叫端（用戶端）處理。
 * @returns 取消訂閱函式
 */
export function subscribeTasks(
  ownerUid: string,
  onData: (tasks: Task[]) => void,
  onError: (error: Error) => void,
): () => void {
  const tasksQuery = query(collection(db, COLLECTIONS.tasks), where('ownerUid', '==', ownerUid));
  return onSnapshot(
    tasksQuery,
    (snapshot) => onData(snapshot.docs.map(mapTask)),
    (error) => onError(new Error(`讀取業務失敗（taskService.subscribeTasks）：${error.message}`)),
  );
}

/**
 * 訂閱單一業務（詳情頁用）。文件不存在時回傳 null。
 * @returns 取消訂閱函式
 */
export function subscribeTask(
  taskId: string,
  onData: (task: Task | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COLLECTIONS.tasks, taskId),
    (snapshot: DocumentSnapshot<DocumentData>) => {
      onData(snapshot.exists() ? mapTaskData(snapshot.id, snapshot.data()) : null);
    },
    (error) => onError(new Error(`讀取業務失敗（taskService.subscribeTask）：${error.message}`)),
  );
}

/** 新增業務；時間戳與擁有者由系統填入，初始為未完成、無進度/待辦。 */
export async function createTask(draft: TaskDraft, ownerUid: string): Promise<string> {
  try {
    const payload = {
      ...draft,
      progressEntries: [],
      checklistItems: [],
      completed: false,
      completionDate: null,
      completionNote: '',
      ownerUid,
      completedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const created = await addDoc(collection(db, COLLECTIONS.tasks), payload);
    return created.id;
  } catch (error) {
    throw new Error(`新增業務失敗（taskService.createTask）：${(error as Error).message}`);
  }
}

/** 更新業務可編輯欄位（不含完成狀態，完成/解除請用 completeTask/reopenTask）。 */
export async function updateTask(taskId: string, fields: Partial<TaskDraft>): Promise<void> {
  try {
    const patch: DocumentData = { ...fields, updatedAt: serverTimestamp() };
    await updateDoc(doc(db, COLLECTIONS.tasks, taskId), patch);
  } catch (error) {
    throw new Error(`更新業務失敗（taskService.updateTask）：${(error as Error).message}`);
  }
}

/** 刪除業務。 */
export async function deleteTask(taskId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, COLLECTIONS.tasks, taskId));
  } catch (error) {
    throw new Error(`刪除業務失敗（taskService.deleteTask）：${(error as Error).message}`);
  }
}

/** 依輸入組出一筆進度紀錄。 */
function buildProgressEntry(input: { date: string; content: string }): ProgressEntry {
  return {
    id: crypto.randomUUID(),
    date: input.date,
    content: input.content,
    createdAt: new Date().toISOString(),
  };
}

/** 新增一筆進度紀錄（日期 + 內容）。 */
export async function addProgressEntry(
  existing: Task,
  input: { date: string; content: string },
): Promise<void> {
  try {
    const next = [...existing.progressEntries, buildProgressEntry(input)];
    await updateDoc(doc(db, COLLECTIONS.tasks, existing.id), {
      progressEntries: next,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`新增進度失敗（taskService.addProgressEntry）：${(error as Error).message}`);
  }
}

/** 刪除一筆進度紀錄。 */
export async function deleteProgressEntry(existing: Task, entryId: string): Promise<void> {
  try {
    const next = existing.progressEntries.filter((entry) => entry.id !== entryId);
    await updateDoc(doc(db, COLLECTIONS.tasks, existing.id), {
      progressEntries: next,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`刪除進度失敗（taskService.deleteProgressEntry）：${(error as Error).message}`);
  }
}

/** 依輸入組出一筆待辦事項。 */
function buildChecklistItem(input: { content: string; deadline: string | null }): ChecklistItem {
  return {
    id: crypto.randomUUID(),
    content: input.content,
    deadline: input.deadline,
    done: false,
    createdAt: new Date().toISOString(),
  };
}

/** 新增一筆待辦事項（內容 + 可選期限）。 */
export async function addChecklistItem(
  existing: Task,
  input: { content: string; deadline: string | null },
): Promise<void> {
  try {
    const next = [...existing.checklistItems, buildChecklistItem(input)];
    await updateDoc(doc(db, COLLECTIONS.tasks, existing.id), {
      checklistItems: next,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`新增待辦失敗（taskService.addChecklistItem）：${(error as Error).message}`);
  }
}

/** 切換一筆待辦事項的完成狀態（勾選/取消）。 */
export async function toggleChecklistItem(existing: Task, itemId: string): Promise<void> {
  try {
    const next = existing.checklistItems.map((item) =>
      item.id === itemId ? { ...item, done: !item.done } : item,
    );
    await updateDoc(doc(db, COLLECTIONS.tasks, existing.id), {
      checklistItems: next,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`更新待辦失敗（taskService.toggleChecklistItem）：${(error as Error).message}`);
  }
}

/** 刪除一筆待辦事項。 */
export async function removeChecklistItem(existing: Task, itemId: string): Promise<void> {
  try {
    const next = existing.checklistItems.filter((item) => item.id !== itemId);
    await updateDoc(doc(db, COLLECTIONS.tasks, existing.id), {
      checklistItems: next,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`刪除待辦失敗（taskService.removeChecklistItem）：${(error as Error).message}`);
  }
}

/** 標記業務完成（鎖定）：記錄完成日期、說明與完成時間。 */
export async function completeTask(
  taskId: string,
  completionDate: string,
  completionNote: string,
): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.tasks, taskId), {
      completed: true,
      completionDate,
      completionNote,
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`標記完成失敗（taskService.completeTask）：${(error as Error).message}`);
  }
}

/** 解除完成（恢復可編輯）：completionDate / completionNote 保留供參考。 */
export async function reopenTask(taskId: string): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.tasks, taskId), {
      completed: false,
      completedAt: null,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`解除完成失敗（taskService.reopenTask）：${(error as Error).message}`);
  }
}
