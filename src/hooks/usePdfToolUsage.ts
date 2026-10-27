/**
 * 管理員看的 PDF 工具使用紀錄：開始顯示時訂閱 30 天內的紀錄，並順手刪掉更舊的。
 */
import { useEffect, useState } from 'react';
import { deleteExpiredPdfToolUsage, subscribeRecentPdfToolUsage } from '../services/pdfToolUsageService';
import type { PdfToolUsage } from '../types/pdfToolUsage';

export function usePdfToolUsage(enabled: boolean) {
  const [records, setRecords] = useState<PdfToolUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    void deleteExpiredPdfToolUsage();
    return subscribeRecentPdfToolUsage(
      (next) => {
        setRecords(next);
        setLoading(false);
      },
      (message) => {
        setError(message);
        setLoading(false);
      },
    );
  }, [enabled]);

  return { records, loading, error };
}
