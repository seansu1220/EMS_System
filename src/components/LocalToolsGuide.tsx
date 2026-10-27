/**
 * 電腦端工具說明（原本的 /tools 頁內容，v1.27 起只給管理員看）。
 *
 * 純顯示元件，不含資料存取邏輯。工具本身是在個人電腦上執行的本機程式，
 * 因為要處理含個案明細的資料，一律不經過網路系統，也不在此呈現任何查詢結果。
 */
import { Card } from './ui';
import { LOCAL_TOOLS } from '../config/localTools';

export function LocalToolsGuide() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        這裡的工具是在你自己的電腦上執行的程式，這個網頁只提供使用說明。
      </p>

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
            不能安裝軟體的電腦（例如公務機），可先在自己電腦雙擊「捷徑 \ 建立可攜版.bat」，
            把工具與 Node.js 打包成一個資料夾複製過去，直接雙擊裡面的捷徑就能用。
          </p>

          <p className="mt-4 text-xs font-medium text-slate-500">操作步驟</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-600">
            {tool.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          {tool.note && (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {tool.note}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
