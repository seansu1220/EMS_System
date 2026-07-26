/**
 * 小工具區頁面（/tools）。
 *
 * 純顯示元件，不含資料存取邏輯。
 * 此頁只放「說明」：工具本身是在個人電腦上執行的本機程式，
 * 因為要處理含個案明細的資料，一律不經過網路系統，也不在此頁呈現任何查詢結果。
 */
import { Card } from '../components/ui';

/** 已可使用的本機工具（配置驅動，新增工具即加一筆）。 */
const LOCAL_TOOLS: readonly {
  title: string;
  purpose: string;
  shortcut: string;
  steps: readonly string[];
}[] = [
  {
    title: '救護紀錄表查詢（到院前預警比率）',
    purpose:
      '自動登入緊急救護管理系統，查詢指定月份已結案的救護紀錄，統計各分隊「到院前預警案件數 ÷ 總案件數」的比率。',
    shortcut: '救護預警統計.bat',
    steps: [
      '在電腦上打開專案資料夾，雙擊上面那個檔案（不用打任何指令）。',
      '程式會自動開啟 Chrome 並停在登入頁，請你本人輸入驗證碼後按登入。',
      '登入成功後程式自動接手查詢與匯出，最後在電腦上產出各分隊的比較表。',
    ],
  },
];

export function ToolsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">小工具</h1>
        <p className="mt-1 text-sm text-slate-500">
          這裡的工具是在你自己的電腦上執行的程式，這個網頁只提供使用說明。
        </p>
      </div>

      <Card className="border-amber-200 bg-amber-50">
        <h2 className="text-sm font-bold text-amber-800">為什麼不做在網頁上？</h2>
        <p className="mt-2 text-sm text-amber-800">
          這些工具會接觸到含有民眾個人資料的救護紀錄。為避免個資外流，資料全程只留在你的電腦裡，
          不會上傳到這個網站或任何雲端；工具最後只產出「各分隊的統計數字」，不含任何個人欄位。
        </p>
      </Card>

      {LOCAL_TOOLS.map((tool) => (
        <Card key={tool.title}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold text-slate-800">{tool.title}</h2>
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              電腦端執行
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-600">{tool.purpose}</p>

          <p className="mt-4 text-xs font-medium text-slate-500">雙擊執行</p>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-100">
            {tool.shortcut}
          </pre>
          <p className="mt-1 text-xs text-slate-400">
            需要該台電腦已安裝 Node.js（Windows 沒有內建，可至 nodejs.org 下載安裝）。
          </p>

          <p className="mt-4 text-xs font-medium text-slate-500">操作步驟</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-600">
            {tool.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
