/**
 * 業務相關型別。
 * 對應 Firestore `tasks/{id}` 文件。
 */

/**
 * 定期業務的週期規則；null 代表單次業務。
 * 以可辨識聯集（discriminated union）表示四種週期型態，type 為判別欄位。
 */
export type RecurrenceRule =
  | { type: 'monthly'; day: number } // 每月 day 號（1-31）
  | { type: 'weekly'; weekday: number } // 每週星期幾（0=日 … 6=六）
  | { type: 'everyNDays'; n: number } // 每 N 天一次（n >= 1）
  | { type: 'yearly'; month: number; day: number }; // 每年 month 月 day 日

/** 單筆進度紀錄：使用者選一個日期 + 填寫當下進度內容。 */
export interface ProgressEntry {
  /** 前端產生的唯一 ID（用於 React key 與刪除）。 */
  id: string;
  /** 進度日期（yyyy-MM-dd）。 */
  date: string;
  /** 進度時間（HH:mm）；null 代表未填時間。 */
  time: string | null;
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
  /** 週期規則；null 代表單次業務。完成一期後期限自動跳至下一期。 */
  recurrence: RecurrenceRule | null;
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
  /** 完成時間（HH:mm）；未填為 null。 */
  completionTime: string | null;
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
  /** 週期規則；null 代表單次業務。 */
  recurrence: RecurrenceRule | null;
  note: string;
}
