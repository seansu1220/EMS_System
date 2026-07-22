/**
 * 業務相關型別。
 * 對應 Firestore `tasks/{id}` 文件。
 */

/** 優先度。 */
export type TaskPriority = 'high' | 'medium' | 'low';

/** 狀態：未開始 / 進行中 / 已完成 / 擱置。 */
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'on_hold';

/** 單筆進度紀錄：使用者選一個日期 + 填寫當下進度內容。 */
export interface ProgressEntry {
  /** 前端產生的唯一 ID（用於 React key 與刪除）。 */
  id: string;
  /** 進度日期（yyyy-MM-dd）。 */
  date: string;
  /** 進度內容描述。 */
  content: string;
  /** 紀錄建立時間（ISO 字串）。 */
  createdAt: string;
}

/** 業務本體。 */
export interface Task {
  /** Firestore 文件 ID。 */
  id: string;
  /** 業務名稱（必填）。 */
  title: string;
  /** 所屬屬性 ID（必填）。 */
  categoryId: string;
  /** 業務說明。 */
  description: string;
  /** 期限（yyyy-MM-dd）；null 代表無期限。 */
  deadline: string | null;
  /** 優先度。 */
  priority: TaskPriority;
  /** 狀態。 */
  status: TaskStatus;
  /** 進度紀錄列表（顯示時由新到舊）。 */
  progressEntries: ProgressEntry[];
  /** 備註。 */
  note: string;
  /** 擁有者 uid。 */
  ownerUid: string;
  /** 建立時間（ISO 字串）。 */
  createdAt: string;
  /** 最後更新時間（ISO 字串）。 */
  updatedAt: string;
  /** 標記完成時間（ISO 字串）；未完成為 null。 */
  completedAt: string | null;
}

/**
 * 新增/編輯業務時的表單輸入（不含系統自動填入的欄位與進度紀錄）。
 * 進度紀錄、時間戳、completedAt 由 service 依狀態自動維護。
 */
export interface TaskDraft {
  title: string;
  categoryId: string;
  description: string;
  deadline: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  note: string;
}
