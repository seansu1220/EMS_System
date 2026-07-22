/**
 * 屬性（分類）相關型別。
 * 對應 Firestore `categories/{id}` 文件。
 */

/** 業務屬性（如：採購、系統、其他）。 */
export interface Category {
  /** Firestore 文件 ID。 */
  id: string;
  /** 屬性名稱。 */
  name: string;
  /** 排序順序（數字越小越前面）。 */
  sortOrder: number;
  /** 擁有者 uid。 */
  ownerUid: string;
  /** 建立時間（ISO 字串）。 */
  createdAt: string;
}

/** 新增屬性時的輸入（不含系統自動填入的 id / ownerUid / createdAt）。 */
export interface CategoryDraft {
  name: string;
  sortOrder: number;
}
