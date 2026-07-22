/**
 * 業務相關型別。
 * 對應 Firestore `tasks/{id}` 文件。
 */

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

/** 單筆待辦事項（checklist）：主進度之外的小問題 / 支線事項。 */
export interface ChecklistItem {
  /** 前端產生的唯一 ID（用於 React key、勾選、刪除）。 */
  id: string;
  /** 待辦內容。 */
  content: string;
  /** 期限（yyyy-MM-dd）；null 代表無期限。 */
  deadline: string | null;
  /** 是否已完成（勾選）。 */
  done: boolean;
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
  /** 進度紀錄列表（顯示時由新到舊）。 */
  progressEntries: ProgressEntry[];
  /** 待辦事項清單。 */
  checklistItems: ChecklistItem[];
  /** 備註。 */
  note: string;
  /** 是否已完成（完成後鎖定，不可修改）。 */
  completed: boolean;
  /** 完成日期（yyyy-MM-dd）；未完成為 null。 */
  completionDate: string | null;
  /** 完成說明。 */
  completionNote: string;
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
 * 新增/編輯業務時的表單輸入（不含系統自動填入的欄位與清單）。
 * 進度紀錄、待辦清單、完成狀態、時間戳由 service 另行維護。
 */
export interface TaskDraft {
  title: string;
  categoryId: string;
  description: string;
  deadline: string | null;
  note: string;
}
