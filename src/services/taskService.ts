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
import { nextOccurrence } from '../lib/recurrence';

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
    // 舊資料無 recurrence 欄位，預設 null（單次業務）。
    recurrence: data.recurrence ?? null,
    progressEntries: Array.isArray(data.progressEntries)
      ? (data.progressEntries as ProgressEntry[]).map((entry) => ({
          ...entry,
          // 舊資料無 time 欄位，預設 null。
          time: entry.time ?? null,
        }))
      : [],
    checklistItems: Array.isArray(data.checklistItems)
      ? (data.checklistItems as ChecklistItem[])
      : [],
    note: data.note ?? '',
    completed: data.completed ?? data.status === 'done',
    completionDate: data.completionDate ?? null,
    completionTime: data.completionTime ?? null,
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
      completionTime: null,
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
function buildProgressEntry(input: {
  date: string;
  time: string | null;
  content: string;
}): ProgressEntry {
  return {
    id: crypto.randomUUID(),
    date: input.date,
    time: input.time,
    content: input.content,
    createdAt: new Date().toISOString(),
  };
}

/** 新增一筆進度紀錄（日期 + 時間 + 內容）。 */
export async function addProgressEntry(
  existing: Task,
  input: { date: string; time: string | null; content: string },
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

/**
 * 勾選待辦完成並同時寫入一筆進度紀錄（同一次 updateDoc，避免兩次寫入）。
 * 將指定待辦 done=true，並 append 一筆進度（date=今天、time=當下、content=「完成待辦：<內容>」）。
 * @param existing 目前業務
 * @param itemId 要勾選完成的待辦 ID
 * @param today 今天日期（yyyy-MM-dd，由呼叫端以純函式取得）
 * @param nowTime 當下時間（HH:mm，由呼叫端以純函式取得）
 */
export async function completeChecklistItemWithProgress(
  existing: Task,
  itemId: string,
  today: string,
  nowTime: string,
): Promise<void> {
  try {
    const target = existing.checklistItems.find((item) => item.id === itemId);
    const nextChecklist = existing.checklistItems.map((item) =>
      item.id === itemId ? { ...item, done: true } : item,
    );
    const nextProgress = [
      ...existing.progressEntries,
      buildProgressEntry({
        date: today,
        time: nowTime,
        content: `完成待辦：${target?.content ?? ''}`,
      }),
    ];
    await updateDoc(doc(db, COLLECTIONS.tasks, existing.id), {
      checklistItems: nextChecklist,
      progressEntries: nextProgress,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(
      `勾選待辦並寫入進度失敗（taskService.completeChecklistItemWithProgress）：${(error as Error).message}`,
    );
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

/** 標記業務完成（鎖定）：記錄完成日期、完成時間與說明。 */
export async function completeTask(
  taskId: string,
  completionDate: string,
  completionTime: string | null,
  completionNote: string,
): Promise<void> {
  try {
    await updateDoc(doc(db, COLLECTIONS.tasks, taskId), {
      completed: true,
      completionDate,
      completionTime,
      completionNote,
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`標記完成失敗（taskService.completeTask）：${(error as Error).message}`);
  }
}

/**
 * 完成定期業務的本期：同一次 updateDoc 完成兩件事（不鎖定業務）：
 *  1. append 一筆進度紀錄（content=「本期完成」或「本期完成：<note>」）。
 *  2. 將 deadline 更新為下一個週期日。
 * 下一期起算基準 base = existing.deadline 與 input.date 兩者較大者（避免補登舊日期時期限倒退）；
 * existing.deadline 為 null 時以 input.date 起算。
 * @param existing 目前業務（recurrence 不可為 null）
 * @param input 本期完成的日期、時間與備註
 */
export async function completeRecurringCycle(
  existing: Task,
  input: { date: string; time: string | null; note: string },
): Promise<void> {
  if (existing.recurrence === null) {
    throw new Error(
      '完成本期失敗（taskService.completeRecurringCycle）：此業務非定期業務（recurrence 為 null）。',
    );
  }
  try {
    const trimmedNote = input.note.trim();
    const content = trimmedNote ? `本期完成：${trimmedNote}` : '本期完成';
    const nextProgress = [
      ...existing.progressEntries,
      buildProgressEntry({ date: input.date, time: input.time, content }),
    ];
    // 起算基準取現有期限與本期完成日期的較大者（localeCompare 比較 yyyy-MM-dd）。
    const base =
      existing.deadline && existing.deadline.localeCompare(input.date) > 0
        ? existing.deadline
        : input.date;
    const nextDeadline = nextOccurrence(existing.recurrence, base);
    await updateDoc(doc(db, COLLECTIONS.tasks, existing.id), {
      progressEntries: nextProgress,
      deadline: nextDeadline,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    throw new Error(`完成本期失敗（taskService.completeRecurringCycle）：${(error as Error).message}`);
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
