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
    title: '月度報表輸出（每個月就用這一個）',
    purpose:
      '一次登入，把「到院前預警比率」與「12 導程心電圖到院前傳輸率」兩份報表都做完，再附上心電圖那邊要追蹤的清冊。',
    shortcut: '捷徑 \\ 月度報表輸出.bat',
    steps: [
      '在電腦上打開專案資料夾的「捷徑」資料夾，雙擊上面那個檔案（不用打任何指令）。',
      '程式會自動開啟 Chrome 並停在登入頁，請你本人輸入驗證碼後按登入。',
      '接著全自動。預警那份約 3~5 分鐘；心電圖那份要一件一件核對上傳時間，可能要跑一兩個小時。',
      '每核完一件就會存檔，中途關掉視窗也不用從頭再來，下次執行會接著跑。',
    ],
    note: '前面那份做失敗不會影響後面那份，結束時會列出每一份是完成還是失敗。只要其中一份時，用「救護預警統計.bat」。',
  },
  {
    title: '到院前預警比率',
    purpose:
      '查詢指定月份「已結案且有送醫」的救護紀錄，統計各分隊「到院前預警案件數 ÷ 送醫案件數」的比率。',
    shortcut: '捷徑 \\ 救護預警統計.bat',
    steps: [
      '雙擊上面那個檔案，程式開啟瀏覽器停在登入頁，請你本人輸入驗證碼後按登入。',
      '登入成功後程式自動接手查詢與匯出，最後在電腦上產出各分隊的比較表。',
      '報表有兩個分頁：一個依大隊排列、一個依預警率高低排序。',
    ],
    note: '若有設定「增減試算表」，期間內列在上面的案件會從送醫案件數（分母）扣除。',
  },
  {
    title: '12 導程心電圖到院前傳輸率',
    purpose:
      '統計各分隊「做了 12 導程心電圖，而且在到院前就傳出去」的比率。分母是有做 EKG 檢查的案件。',
    shortcut: '捷徑 \\ 月度報表輸出.bat（含在裡面）',
    steps: [
      '系統的查詢只查得到「有沒有做 12 導程」，查不到「什麼時候傳出去的」，所以程式會一件一件點開核對。',
      '每一件都讀到院時間，再去傳輸紀錄看上傳時間；傳輸紀錄找不到就進案件內部從「上傳」找。',
      '上傳時間在到院之後的，不算有做；判斷不出來的不計入，另外列成一張清單給你自己看。',
      '另外會產出「有處置未勾選清冊」：有上傳心電圖、卻沒勾急救處置的案件，第一個分頁就是各分隊件數，拿去提醒同仁記得點處置。',
    ],
    note: '第一次請先跑「捷徑 \\ 不常用 \\ 心電圖傳輸統計-試跑5件.bat」，確認到院時間與上傳時間都有讀對，再跑整個月。',
  },
  {
    title: '解鎖救護紀錄表',
    purpose:
      '給一組 TEMSIS 編號，程式自動查出對應的指派案號，到案件列表找出那件案子，找出該把哪一張救護紀錄表調整為未結案。',
    shortcut: '捷徑 \\ 解鎖救護紀錄表.bat（試跑）／正式解鎖救護紀錄表.bat（真的解）',
    steps: [
      '雙擊上面那個檔案，把 TEMSIS 一個一行貼上（貼一個按一次 Enter 換行）；全部貼完後，在空白的那一行再按一次 Enter 才開始執行。',
      '程式開啟瀏覽器停在登入頁，請你本人輸入驗證碼後按登入。',
      '接著全自動：查紀錄表 → 讀指派案號 → 查案件列表 → 進入案件；同一件有多張紀錄表時，會逐張比對 TEMSIS 找出正確的那張。',
      '正式模式跑完會單獨列出「這次到底動了哪幾件」：日期時間、車輛（分隊）、第幾張紀錄表。',
      '有沒有解開是看畫面：出現「已修改為未結案並解鎖」的訊息，或你按的那一列從「救護紀錄(鎖)」變成「救護紀錄」，任一個成立就算解開。',
      '每一筆都會記下案件日期與出勤車輛，寫在 tools\\ems-report\\out\\last-run.log，事後要回頭查看得到。',
    ],
    note: '雙擊「解鎖救護紀錄表.bat」是試跑，只告訴你該解哪一張，不會動到系統；要真的解請用「正式解鎖救護紀錄表.bat」。解鎖無法復原，所以判斷不明確的案件（比對不到、多張都相符、或有紀錄表打不開）一律略過，不會用猜的。',
  },
  {
    title: '線上解鎖工單（處理各分隊在網頁上的申請）',
    purpose:
      '把各分隊在「解鎖工單」頁提出的申請一次處理完，結果自動回到網頁上，不用再打電話回覆。',
    shortcut: '捷徑 \\ 線上解鎖工單.bat',
    steps: [
      '雙擊上面那個檔案，程式會先告訴你目前有幾筆待處理；一筆都沒有的話連瀏覽器都不會開。',
      '瀏覽器停在登入頁，請你本人輸入驗證碼後按登入，接著全自動。',
      '每解完一筆就立刻回寫一筆，申請人在網頁上看得到，中途關掉視窗也不會讓前面幾筆卡在「待處理」。',
      '判斷方式與離線版完全相同：判斷不明確的一律略過，不會用猜的。',
    ],
    note: '第一次要先給程式一組帳密。你平常用 Google 登入，而 Google 登入沒有密碼可以填，所以請另外開一組專用帳號：在「建立新帳號」頁註冊（Email 可用 你的帳號+unlock@gmail.com 這種 Gmail 別名，信一樣進你的信箱）→ 回來用你自己的帳號在使用者管理核准它、角色維持「一般使用者」→ 把帳密填進 tools\\ems-report\\.env 的 EMS_WEB_EMAIL 與 EMS_WEB_PASSWORD。填完先跑「捷徑 \\ 不常用 \\ 線上解鎖工單-試跑.bat」確認連得上。',
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
