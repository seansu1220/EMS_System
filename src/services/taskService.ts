/**
 * 業務（task）業務邏輯：查詢、新增、更新、刪除、進度管理。
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
import { COLLECTIONS, DEFAULT_PRIORITY, DEFAULT_STATUS, DONE_STATUS } from '../config/constants';
import type { ProgressEntry, Task, TaskDraft, TaskStatus } from '../types/task';

/** Firestore Timestamp / 字串 → ISO 字串。 */
function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/** 由文件 ID 與原始資料組出強型別 Task。 */
function mapTaskData(id: string, data: DocumentData): Task {
  return {
    id,
    title: data.title ?? '',
    categoryId: data.categoryId ?? '',
    description: data.description ?? '',
    deadline: data.deadline ?? null,
    priority: data.priority ?? DEFAULT_PRIORITY,
    status: data.status ?? DEFAULT_STATUS,
    progressEntries: Array.isArray(data.progressEntries)
      ? (data.progressEntries as ProgressEntry[])
      : [],
    note: data.note ?? '',
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

/** 新增業務；時間戳與擁有者由系統填入，狀態為已完成時記錄 completedAt。 */
export async function createTask(draft: TaskDraft, ownerUid: string): Promise<string> {
  try {
    const payload = {
      ...draft,
      progressEntries: [],
      ownerUid,
      completedAt: draft.status === DONE_STATUS ? serverTimestamp() : null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const created = await addDoc(collection(db, COLLECTIONS.tasks), payload);
    return created.id;
  } catch (error) {
    throw new Error(`新增業務失敗（taskService.createTask）：${(error as Error).message}`);
  }
}

/**
 * 更新業務可編輯欄位。
 * 若本次更動了狀態：改為「已完成」時記錄 completedAt；改回其他狀態則清空。
 * @param prevStatus 更新前的狀態（用來判斷是否需要調整 completedAt）
 */
export async function updateTask(
  taskId: string,
  fields: Partial<TaskDraft>,
  prevStatus: TaskStatus,
): Promise<void> {
  try {
    const patch: DocumentData = { ...fields, updatedAt: serverTimestamp() };
    if (fields.status && fields.status !== prevStatus) {
      patch.completedAt = fields.status === DONE_STATUS ? serverTimestamp() : null;
    }
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
