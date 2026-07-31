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
  /** 額外提醒（選填），例如目前的限制。 */
  note?: string;
}[] = [
  {
    title: '救護紀錄表查詢（到院前預警比率）',
    purpose:
      '自動登入緊急救護管理系統，查詢指定月份已結案的救護紀錄，統計各分隊「到院前預警案件數 ÷ 總案件數」的比率。',
    shortcut: '捷徑 \\ 救護預警統計.bat',
    steps: [
      '在電腦上打開專案資料夾的「捷徑」資料夾，雙擊上面那個檔案（不用打任何指令）。',
      '程式會自動開啟 Chrome 並停在登入頁，請你本人輸入驗證碼後按登入。',
      '登入成功後程式自動接手查詢與匯出，最後在電腦上產出各分隊的比較表。',
    ],
  },
  {
    title: '解鎖救護紀錄表',
    purpose:
      '給一組 TEMSIS 編號，程式自動查出對應的指派案號，到案件列表找出那件案子，把正確的那張救護紀錄表調整為未結案。',
    shortcut: '捷徑 \\ 解鎖救護紀錄表.bat',
    steps: [
      '雙擊上面那個檔案，把 TEMSIS 一個一行貼上（貼一個按一次 Enter 換行）；全部貼完後，在空白的那一行再按一次 Enter 才開始執行。',
      '程式開啟瀏覽器停在登入頁，請你本人輸入驗證碼後按登入。',
      '接著全自動：查紀錄表 → 讀指派案號 → 查案件列表 → 進入案件；同一件有多張紀錄表時，會逐張比對 TEMSIS 找出正確的那張，再按下「調整為未結案」。',
      '每解一筆都會記下案件日期與出勤車輛，寫在 tools\\ems-report\\out\\last-run.log，事後要回頭查看得到。',
    ],
    note: '判斷不明確的案件（比對不到、或同一件有多張都相符）一律略過不動，不會用猜的，並在結果裡告訴你要自己處理哪幾筆。解完會回頭確認狀態真的變了才算成功。',
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
