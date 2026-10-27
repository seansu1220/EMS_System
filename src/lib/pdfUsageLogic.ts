/**
 * PDF 工具使用紀錄的整理（純函式）：依人彙總、動作的顯示名稱、時間格式。
 */
import { PDF_USAGE_CONFIG } from '../config/pdfTools';
import type { PdfToolUsage } from '../types/pdfToolUsage';

export interface PdfUsageSummary {
  uid: string;
  userName: string;
  email: string;
  /** 開啟檔案次數。 */
  opens: number;
  /** 下載次數。 */
  downloads: number;
  /** 下載的總頁數。 */
  downloadedPages: number;
  /** 最近一次（ISO）。 */
  lastUsedAt: string;
}

/** 依人彙總（最近用過的排前面）。records 須為新到舊。 */
export function summarizeUsageByUser(records: readonly PdfToolUsage[]): PdfUsageSummary[] {
  const byUser = new Map<string, PdfUsageSummary>();
  for (const record of records) {
    let summary = byUser.get(record.uid);
    if (!summary) {
      summary = { uid: record.uid, userName: record.userName, email: record.email, opens: 0, downloads: 0, downloadedPages: 0, lastUsedAt: record.usedAt };
      byUser.set(record.uid, summary);
    }
    if (record.action === 'open') {
      summary.opens += 1;
    } else {
      summary.downloads += 1;
      summary.downloadedPages += record.pageCount;
    }
  }
  return [...byUser.values()];
}

/** 動作的顯示名稱；多個檔一起下載全部時叫「合併下載」。 */
export function usageActionLabel(record: Pick<PdfToolUsage, 'action' | 'sourceCount'>): string {
  if (record.action === 'downloadAll' && record.sourceCount > 1) return '合併下載';
  return PDF_USAGE_CONFIG.actionLabels[record.action] ?? record.action;
}

const TIME_FORMAT = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** ISO → 「2026/10/27 14:05」（台灣時間）。 */
export function formatUsageTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : TIME_FORMAT.format(date);
}
