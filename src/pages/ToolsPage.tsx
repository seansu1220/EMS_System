/**
 * 小工具區頁面（/tools）。
 * 目前為「保留區域」：實際工具待使用者提供規格後再評估實作方式。
 * 純顯示元件，不含資料存取邏輯。
 */
import { Card } from '../components/ui';

/** 規劃中的工具項目（配置驅動，之後逐一實作即從此清單移除或改為實體卡片）。 */
const PLANNED_TOOLS: readonly { title: string; description: string }[] = [
  {
    title: '內部系統資料匯出',
    description: '登入內部系統後自動抓取指定資料並匯出 Excel。待提供目標網站與欄位後評估作法。',
  },
];

export function ToolsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">小工具</h1>
        <p className="mt-1 text-sm text-slate-500">
          此區保留給日後的輔助工具，規格確定後將陸續開放。
        </p>
      </div>

      {PLANNED_TOOLS.map((tool) => (
        <Card key={tool.title} className="opacity-60">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-500">{tool.title}（規劃中）</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-400">
              尚未開放
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-400">{tool.description}</p>
        </Card>
      ))}
    </div>
  );
}
