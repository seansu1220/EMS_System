/**
 * 小工具頁「使用紀錄」分區（僅管理員）：30 天內有誰用過 PDF 工具。
 * 上半依人彙總（開啟、下載各幾次），下半逐筆列出。紀錄只有數字，不含檔名（見 types/pdfToolUsage.ts）。
 */
import { PDF_USAGE_CONFIG } from '../config/pdfTools';
import { usePdfToolUsage } from '../hooks/usePdfToolUsage';
import { formatUsageTime, summarizeUsageByUser, usageActionLabel } from '../lib/pdfUsageLogic';
import { Card, CenteredSpinner, ErrorBanner } from './ui';

const TH = 'px-3 py-2 text-left text-xs font-medium text-slate-500';
const TD = 'px-3 py-2 text-sm text-slate-700';

export function PdfUsageLog({ active }: { active: boolean }) {
  const { records, loading, error } = usePdfToolUsage(active);
  if (!active) return null;
  if (loading) return <CenteredSpinner label="讀取使用紀錄中…" />;
  const summary = summarizeUsageByUser(records);

  return (
    <div className="space-y-4" data-ws="usage-log">
      <ErrorBanner message={error} />
      <p className="text-sm text-slate-500">
        近 {PDF_USAGE_CONFIG.retentionDays} 天內 PDF 工具的使用紀錄（每次開啟檔案、每按一次下載各記一筆）。只記人、時間、動作與頁數，
        <strong className="text-slate-700">不記檔名</strong>；超過 {PDF_USAGE_CONFIG.retentionDays} 天的會自動刪除。
      </p>

      {records.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">近 {PDF_USAGE_CONFIG.retentionDays} 天內還沒有人用過。</p>
        </Card>
      ) : (
        <>
          <Card className="overflow-x-auto p-0">
            <h2 className="px-4 pt-4 text-sm font-bold text-slate-800">依人統計（{summary.length} 人）</h2>
            <table className="mt-2 w-full min-w-[560px]">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className={TH}>人員</th>
                  <th className={TH}>開啟次數</th>
                  <th className={TH}>下載次數</th>
                  <th className={TH}>下載頁數</th>
                  <th className={TH}>最近使用</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((item) => (
                  <tr key={item.uid} className="border-b border-slate-100 last:border-0">
                    <td className={TD}>
                      {item.userName}
                      <div className="text-xs text-slate-400">{item.email}</div>
                    </td>
                    <td className={TD}>{item.opens}</td>
                    <td className={TD}>{item.downloads}</td>
                    <td className={TD}>{item.downloadedPages}</td>
                    <td className={TD}>{formatUsageTime(item.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="overflow-x-auto p-0">
            <h2 className="px-4 pt-4 text-sm font-bold text-slate-800">逐筆紀錄（{records.length} 筆）</h2>
            <table className="mt-2 w-full min-w-[560px]">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className={TH}>時間</th>
                  <th className={TH}>人員</th>
                  <th className={TH}>動作</th>
                  <th className={TH}>頁數</th>
                  <th className={TH}>檔案數</th>
                  <th className={TH}>有標記的頁</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="border-b border-slate-100 last:border-0">
                    <td className={`${TD} whitespace-nowrap`}>{formatUsageTime(record.usedAt)}</td>
                    <td className={TD}>{record.userName}</td>
                    <td className={TD}>{usageActionLabel(record)}</td>
                    <td className={TD}>{record.pageCount}</td>
                    <td className={TD}>{record.fileCount}</td>
                    <td className={TD}>{record.markedPages || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
