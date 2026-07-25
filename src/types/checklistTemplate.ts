/**
 * 待辦公版（範本）相關型別。
 * 對應 Firestore `checklistTemplates/{id}` 文件。
 *
 * 用途：把常做的一套流程（例如標案的各個關卡）存成公版，
 * 之後新增業務或既有業務要展開流程時，一鍵帶入成為待辦事項。
 * 公版只保存「項目內容與順序」，不含期限與勾選狀態（期限於套用後個別編輯）。
 */

/** 公版中的單筆項目。 */
export interface ChecklistTemplateItem {
  /** 前端產生的唯一 ID（用於 React key、排序、刪除）。 */
  id: string;
  /** 項目內容（套用後成為待辦內容）。 */
  content: string;
  /** 流程順序（0..n-1，越小越前面）。 */
  sortOrder: number;
}

/** 待辦公版本體。 */
export interface ChecklistTemplate {
  /** Firestore 文件 ID。 */
  id: string;
  /** 公版名稱（例如「標案標準流程」）。 */
  name: string;
  /** 公版項目（依 sortOrder 排序）。 */
  items: ChecklistTemplateItem[];
  /** 擁有者 uid。 */
  ownerUid: string;
  /** 建立時間（ISO 字串）。 */
  createdAt: string;
  /** 最後更新時間（ISO 字串）。 */
  updatedAt: string;
}
