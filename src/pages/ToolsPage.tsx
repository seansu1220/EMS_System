/**
 * 小工具區頁面（/tools）。
 * 目前提供「表格轉 Excel」：把從網頁 / 內部系統複製的表格文字貼上後匯出 .xlsx。
 * UI 純顯示 + 事件捕捉；表格解析交由 lib/tableParse（純函式），Excel 產生用 SheetJS。
 */
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { parseClipboardTable } from '../lib/tableParse';
import { Button, Card, ErrorBanner, FieldLabel, INPUT_CLASS } from '../components/ui';

/** 預覽最多顯示的列數。 */
const PREVIEW_ROW_LIMIT = 20;

export function ToolsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-slate-800">小工具</h1>
      <TableToExcelTool />
      <PlaceholderTool />
    </div>
  );
}

/** 工具卡片一：表格轉 Excel（可展開 / 收合）。 */
function TableToExcelTool() {
  const [expanded, setExpanded] = useState(true);
  const [rawText, setRawText] = useState('');
  const [fileName, setFileName] = useState('匯出資料');
  const [error, setError] = useState<string | null>(null);

  // 解析結果（純函式，隨輸入即時計算）。
  const rows = useMemo(() => parseClipboardTable(rawText), [rawText]);
  const rowCount = rows.length;
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const previewRows = rows.slice(0, PREVIEW_ROW_LIMIT);

  /** 匯出 Excel：以二維陣列建立工作表後下載 .xlsx。 */
  function handleExport() {
    if (rows.length === 0) {
      setError('沒有可匯出的資料，請先貼上表格內容。');
      return;
    }
    setError(null);
    try {
      const name = fileName.trim() || '匯出資料';
      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, '工作表1');
      XLSX.writeFile(workbook, `${name}.xlsx`);
    } catch (err) {
      setError(`匯出 Excel 失敗（ToolsPage.handleExport）：${(err as Error).message}`);
    }
  }

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between text-left"
      >
        <h2 className="text-base font-bold text-slate-800">表格轉 Excel</h2>
        <span className="text-sm font-medium text-slate-500">{expanded ? '收合' : '展開'}</span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-slate-500">
            從網頁或內部系統複製表格（Ctrl+C），貼到下方文字框，即可匯出 .xlsx。
          </p>

          <div>
            <FieldLabel optional>貼上表格內容</FieldLabel>
            <textarea
              rows={6}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="在此貼上（Ctrl+V）從表格複製的內容…"
              className={`${INPUT_CLASS} font-mono`}
            />
          </div>

          {rowCount > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                共 {rowCount} 列 × {columnCount} 欄
                {rowCount > PREVIEW_ROW_LIMIT && `（僅預覽前 ${PREVIEW_ROW_LIMIT} 列）`}
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full border-collapse text-sm">
                  <tbody>
                    {previewRows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-slate-100 last:border-b-0">
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className="whitespace-nowrap border-r border-slate-100 px-3 py-1.5 text-slate-700 last:border-r-0"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rowCount > PREVIEW_ROW_LIMIT && (
                <p className="text-xs text-slate-400">…共 {rowCount} 列</p>
              )}
            </div>
          )}

          <ErrorBanner message={error} />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-60">
              <FieldLabel optional>檔名</FieldLabel>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="匯出資料"
                  className={INPUT_CLASS}
                />
                <span className="shrink-0 text-sm text-slate-400">.xlsx</span>
              </div>
            </div>
            <div className="sm:flex-1 sm:text-right">
              <Button onClick={handleExport}>匯出 Excel</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/** 工具卡片二（規劃中）：內部系統資料匯出。 */
function PlaceholderTool() {
  return (
    <Card className="opacity-60">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-500">內部系統資料匯出（規劃中）</h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-400">
          尚未開放
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-400">待提供目標網站後開發。</p>
    </Card>
  );
}
