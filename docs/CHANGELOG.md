# 變更紀錄（CHANGELOG）

本檔透過 git 同步，供多台電腦查閱歷史紀錄。

---

## 2026-07-28　v1.11.3 匯出失敗改為立即偵測並自動重試

### 問題描述
使用者實跑時頁面出現系統自身的錯誤 `Error!!! wap119.RPS64101030_1._btnExcel()`，
但程式沒有任何反應，仍持續執行，使用者無法判斷該不該繼續等。

### 根本原因
匯出在**伺服器端**拋出例外時不會產生任何下載，而程式只監聽下載事件，
因此必然乾等到 `DOWNLOAD_TIMEOUT_MS`（180 秒）才報「等待匯出檔案超過 180 秒仍未開始下載」。
執行紀錄顯示四項查詢條件（期間、救護狀態、送醫情形、院前預警）皆已回讀確認成功，
查詢本身也在 12.5 秒內完成，問題確實只發生在匯出動作。

### 修改的檔案與內容摘要
- `tools/ems-report/config.mjs`：新增 `SITE.errorMarker = 'Error!!!'`（系統錯誤訊息開頭字樣）。
- `tools/ems-report/scrape.mjs`：
  - 新增 `watchForSiteError`：每 2 秒檢查內容框是否出現 `Error!!!`，出現即立刻中止並回報該行訊息。
    **只取錯誤訊息那一行**，不讀取也不記錄頁面上的查詢結果內容（個資保護）。
  - `exportExcel` 改為與錯誤監看競賽，下載成功後以旗標停止監看。
  - 新增 `exportExcelWithRetry`：匯出失敗時重新查詢並再試一次。
    失敗現在能在數秒內偵測到，重試成本低，可省去使用者為重跑而重新登入。
- `docs/TOOLS_SPEC.md`：「實跑踩過的坑」新增一條。

### 待釐清
匯出失敗的根本原因尚未確定。使用者提到目標系統當天有改版。
需以「手動在瀏覽器操作相同條件並匯出」來區分是系統端問題或自動化問題。

### 需求描述
使用者補充：先前說明漏了一個條件——除了救護狀態＝「已結案」，
還須將**送醫／未運送**選為「**送醫**」，數據才正確。

### 影響說明（非程式缺陷，是查詢口徑錯誤）
原本只篩「已結案」，母數會把**未運送案件**（誤報、拒送、中途取消、未發現、
警察處理、現場死亡等）一併算入。這類案件不會有到院前預警，
留在母數裡會讓預警比率被稀釋而偏低。

因此 v1.11.1 記錄的實測基準（總案件 10,557 / 預警 7,290）自本版起不再適用；
新口徑的案件數會低於該值，屬預期變化，分隊數（41）不受影響。

### 修改的檔案與內容摘要
- `tools/ems-report/config.mjs`：
  - `SITE.queryFields` 新增 `transport: '#_selSPA11'`。
  - `QUERY_CRITERIA` 新增 `transportValue: '1'`／`transportLabel: '送醫'`
    （選項值取自探測結果：未運送＝`0`、送醫＝`1`），並註明少了這個條件會使母數偏高。
- `tools/ems-report/scrape.mjs`：`applyCommonCriteria` 補上送醫情形的設定，
  與其他條件一樣先 `ensureFieldVisible` 再選取，且**填完回讀驗證**；
  函式註解說明為何必須限定「送醫」。兩次查詢（總案件／預警案件）皆套用此條件。
- `docs/TOOLS_SPEC.md`：1.3 自動化流程改列三項共同條件；1.4 補上送醫情形欄位與選項值；
  1.8 標註舊基準值的適用口徑並說明新口徑待實跑後補上。

### 待驗證
- 需再實跑一次確認新口徑數字正確（分隊數仍應為 41，案件數會低於舊值）。

---

## 2026-07-26　v1.11.1 實跑驗證通過，並記錄後續規劃

### 驗證結果
使用者實跑並與自行核對的數據比對，**結果一致**，小工具功能確認完成。

| 項目 | 值 |
| --- | --- |
| 查詢期間 | 2026-06-01 00:00:00 ~ 2026-06-30 23:59:59 |
| 總案件（已結案） | 10,557 筆 |
| 到院前預警案件 | 7,290 筆 |
| 分隊數 | 41 個 |
| 分隊欄位判定 | 「出勤單位」，內容 100% 以分隊／大隊結尾 |
| 執行時間 | 約 3.5 分鐘 |

前一版誤判的「分隊 自行受理」確認為**勾選記號欄**（值為 V），與分隊無關；
改以內容判定後正確選中「出勤單位」。

### 修改的檔案與內容摘要
- `tools/ems-report/config.mjs`：`SQUAD_COLUMN_CANDIDATES` 補入實測欄名「出勤單位」並置於第一順位，
  註解標明「分隊 自行受理」是勾選欄不可誤用。
- `tools/ems-report/index.mjs`：匯出檔有 208 欄，原本每次都把完整欄名寫進紀錄檔，
  導致 log 難以閱讀；改為**只在分隊欄位判定沒把握（非內容判定）時才列出完整欄名**。
- `docs/TOOLS_SPEC.md`：1.4 補上匯出檔的分隊欄位與欄數；1.8 記錄實測基準值（可作日後回歸比對）；
  新增 1.9「後續規劃」。

### 後續規劃（使用者提出，細節待補）
- **嵌入另一份資料做數據增減**：使用者表示之後會再提供一份資料，用來對統計結果做增減調整。
  資料來源、格式、增減規則（調整分子／分母或另立欄位）待說明後規劃。
  預期改動範圍已記於 `docs/TOOLS_SPEC.md` 1.9 節。

---

## 2026-07-26　v1.11 登入輸入焦點修正、規格書拆分、根目錄整理

### 問題一：輸入驗證碼時焦點一直被搶走
- **現象**：使用者反映打驗證碼時，游標會在使用者／密碼／驗證碼三個欄位間跳動，難以輸入。
- **根本原因**：`waitForLogin` 的輪詢迴圈**每秒都呼叫一次代填**，每次都重寫帳密欄位
  並把焦點移到驗證碼欄，等於使用者每打一個字就被打斷一次。
- **修正**：`session.mjs` 的 `fillCredentialsIfPresent` 改為**只在帳密欄位為空時才動作**，
  一旦有值就完全不再碰；焦點也只在剛填完的那一次移動。
  登入失敗退回空白表單時（欄位變空）才會再代填一次，並記錄一行說明。

### 變更二：規格書拆分為兩本
- **原因**：小工具的細部規格（目標系統結構、模組職責、踩過的坑）越寫越長，
  再放在主系統 SPEC 裡會把網頁功能規格淹沒。
- **作法**：新增 `docs/TOOLS_SPEC.md`，把原 SPEC 第 4 章整章搬過去並擴充；
  `docs/SPEC.md` 第 4 章改為指向新檔的簡短說明，章節編號維持 1~7 不變。
  新檔結構為「第 0 章通則（所有小工具共用的定位與個資保護總則）」＋「每個工具一章」，
  日後新增工具直接加章節即可。
- 新檔另增「**實跑踩過的坑**」對照表（現象 → 真正原因 → 對策），共 9 條，
  供日後系統改版或接手者快速定位。
- `CLAUDE.md`：規格同步規範改為明確指出兩本規格書各自的適用範圍。

### 變更三：根目錄整理
- **原因**：四個 .bat 檔散在根目錄，與建置設定檔混在一起，不易辨識。
- **作法**：新增 `捷徑/` 資料夾收納全部批次檔，各檔的 `cd /d "%~dp0"` 改為 `cd /d "%~dp0.."`。
- **安全性確認**（使用者要求）：其餘根目錄檔案皆為工具鏈固定位置，一律不動——
  `index.html`／`vite.config.ts`／`tsconfig*.json`（Vite 建置入口）、
  `firebase.json`／`.firebaserc`（Firebase CLI 固定讀根目錄）、
  `package.json`／`.env`／`.gitignore`／`CLAUDE.md`。
- **已實測**：以 cmd 執行位於 `捷徑/` 的批次檔，確認工作目錄正確落在專案根目錄
  （`CWD=d:\ClaudeCode\EMS_System`），且 `package.json`、`tools/ems-report/index.mjs`、
  `tools/ems-report/.env.example`、`node_modules/playwright-core/` 四項相依路徑皆解析成功。
- 同步更新引用位置：`docs/SPEC.md` 目錄結構、`tools/ems-report/README.md`、
  `tools/ems-report/index.mjs` 檔頭說明、`src/pages/ToolsPage.tsx` 的操作說明。

### 已驗證
- `npm run tool:ems:test`：20 項全數通過。
- `npm run build`：TypeScript 編譯與打包成功。

---

## 2026-07-26　v1.10.1 實跑修正：日期含時間、分隊欄位誤判、登入時序與漏 import

首次對真實系統實跑，依序修正四個問題。

### 問題一：登入後主畫面尚未載入就往下走
- **現象**：`找不到名為 contentSidemenu 的 frame`，且失敗發生在「登入完成」後 1 毫秒。
- **原因**：以「驗證碼欄位消失」判定登入完成，但那只代表表單送出，
  系統此時還在組 frameset，各 frame 尚不存在。先前探測能過只是擷取動作恰好爭取到時間。
- **修正**：`session.mjs` 新增 `waitForAppReady`，等 `contentSidemenu` 與 `contentFrame`
  真正出現才繼續。

### 問題二：新增的常數漏 import
- **現象**：`APP_READY_TIMEOUT_MS is not defined`，實跑才爆。
- **原因**：常數只加進 `config.mjs`，忘了在 `session.mjs` import。
  `node --check` 只驗語法、不驗未定義引用，故未被擋下。
- **修正**：補上 import；新增 `session.test.mjs` 以假的 page 物件**實際執行**
  `waitForAppReady`，讓這類「跑到才現形」的錯誤能在測試階段暴露。

### 問題三：日期條件根本沒生效（最嚴重）
- **現象**：查詢期間設為 2026-06 卻撈到 10185 筆。
- **原因**：系統日期格式實際為 `yyyy-MM-dd HH:mm:ss`，
  而 `formatDateForSite` 只處理年月日，**`HH:mm:ss` 被原樣留在字串裡**，
  填進去的是「2026-06-01 HH:mm:ss」這種無效值。
- **修正**：`dateRange.mjs` 支援 `HH`／`mm`／`ss`（單次掃描取代，避免 MM 與 mm 互相污染），
  起日補 00:00:00、**迄日補 23:59:59**（否則會漏掉最後一天整天的案件）。
- **並補上防線**：`scrape.mjs` 的欄位填寫改為**填完一律回讀驗證**，值不符即中止，
  不再讓錯誤條件跑完整趟；唯讀欄位（日曆點選）也改為直接判定後寫入，省去兩次 10 秒逾時等待。

### 問題四：分隊欄位認錯，整份報表只算出一個「V」
- **現象**：報表只有一列，分隊名稱是「V」，26／34 件。
- **原因**：匯出檔沒有名為「分隊」的欄位，欄名模糊比對抓到了
  「分隊 自行受理」這個**勾選記號欄**（值為 V）。
- **修正**：`aggregate.mjs` 的 `resolveSquadColumn` 改為**以欄位內容為主要依據**——
  真正的分隊欄，值會大量以「分隊／大隊／中隊」結尾（門檻 80%）；
  內容判斷不出來時才退回欄名比對，且「包含」比對改取最短欄名以避開複合欄。
  回傳值改為 `{ column, reason }`，把判定依據一併記錄。
- **並補上防線**：`index.mjs` 在資料超過 100 筆卻只分出少於 3 個分隊時直接中止並列出實際欄名，
  同時**把匯出檔的完整欄名記入執行紀錄**（欄名屬檔案結構，非個人資料）。

### 修改的檔案
- `tools/ems-report/session.mjs`、`config.mjs`：等待主畫面、`APP_READY_TIMEOUT_MS`。
- `tools/ems-report/dateRange.mjs`：日期樣板支援時分秒與 `endOfDay`。
- `tools/ems-report/scrape.mjs`：回讀驗證、唯讀欄位處理、迄日 23:59:59。
- `tools/ems-report/aggregate.mjs`：分隊欄位改以內容判定。
- `tools/ems-report/index.mjs`：記錄完整欄名、分隊數量合理性檢查。
- 新增 `tools/ems-report/session.test.mjs`；`aggregate.test.mjs`／`dateRange.test.mjs` 補測試。
- 新增 `設定登入帳密.bat`、`tools/ems-report/.env`（已 gitignore，明示密碼為明文儲存）。
- `tools/ems-report/logger.mjs`、`config.mjs`：執行紀錄自動寫入 `out/last-run.log`。

### 已驗證
- `npm run tool:ems:test`：20 項全數通過（原 14 項）。
- 新增測試直接重現兩個實跑缺陷：含時間的日期樣板、被「分隊 自行受理」誤導的欄位判定。

---

## 2026-07-26　v1.10 小工具第二、三階段：查詢、匯出、分隊彙總統計

### 需求描述
完成「各分隊到院前預警比率」的自動化：查詢上個月已結案案件 → 匯出兩份 Excel
（全部／到院前傳送預警）→ 依分隊彙總並產出比較表。

### 探測發現與踩到的坑
1. **上方 header 那排報表連結，登入直後並不存在**（只有「首頁」），
   要進入報表系統後才會出現。原本用它導航必然逾時失敗，改走左側選單。
2. **「查詢」與「匯出EXCEL」不是標準表單按鈕**，而是 `<img id="_btnQuery">`／`<img id="_btnExcel">`，
   因此第一版探測器（只掃 input/button/select）完全掃不到。已擴充為掃描所有帶 onclick
   的元素與圖片，並同步加強遮蔽（資料列表內元素跳過、5 碼以上數字遮蔽）。
3. **兩個進階搜尋是同頁展開，不是彈出視窗**（`triggleTable()`／`triggleTable2()`）。
   展開函式是 toggle，盲目呼叫兩次會把已展開的區塊收起來，故改為「先檢查可見性再決定是否切換」。
4. **SheetJS 的 ESM 版本必須先 `set_fs(fs)`**，否則 `readFile`／`writeFile` 直接拋
   `cannot save file`。這個問題只有在實際讀寫檔時才會出現，已用整合測試釘住。

### 修改的檔案與內容摘要
- 新增 `tools/ems-report/navigation.mjs`：frame 查找（每次重查，因 POST 導頁會重建 frame）、
  導向查詢頁（左側選單為主、直接載入網址為備援）、`ensureFieldVisible` 確保欄位可見。
- 新增 `tools/ems-report/scrape.mjs`：偵測系統日期格式（讀 My97DatePicker 的 `dateFmt`）、
  填入期間與救護狀態、兩次查詢與匯出；下載監聽同時涵蓋主視窗與新開分頁，避免彈窗下載漏接。
- 新增 `tools/ems-report/workbook.mjs`：匯出檔解析，**自動定位標題列**
  （政府匯出檔上方常有報表名稱與查詢條件說明列）；`describeWorkbook` 只回報欄名與筆數。
- 新增 `tools/ems-report/aggregate.mjs`：`resolveSquadColumn`／`countBySquad`／
  `buildComparison`／`summarize`／`formatRatio`，全部為純函式。
- 新增 `tools/ems-report/report.mjs`：終端機對齊表格（中日韓字元寬度計算）與 Excel 報表輸出。
- 新增 `tools/ems-report/xlsxNode.mjs`：SheetJS 的 Node 包裝，統一處理 `set_fs`。
- 新增測試 `aggregate.test.mjs`、`workbook.test.mjs`（共 14 項，含寫出／讀回真實 Excel）。
- `tools/ems-report/dateRange.mjs`：`formatDateForSite` 由三種固定格式改為樣板轉換
  （支援 `yyyy`／`yy`／`ryyy` 民國年／`MM`／`dd`），配合執行時偵測到的系統格式。
- `tools/ems-report/probe.mjs`：抽出導航邏輯至 navigation.mjs；擴充可點擊元素擷取。
- `tools/ems-report/config.mjs`：補上 frame 名稱、AP 代號、備援網址產生器、查詢欄位與按鈕
  選擇器、下拉選項實際值、分隊欄名候選、下載逾時。
- `tools/ems-report/index.mjs`：串接完整流程；解析失敗時保留原始檔並輸出結構診斷。
- `package.json`：新增 `xlsx`（SheetJS 官方 CDN 版）；測試指令改為掃描 `*.test.mjs`；版本 → 1.10.0。
- `docs/SPEC.md`：新增 4.5 探測結果、4.7 統計規則，模組職責與進度同步更新。

### 個資防護（沿用並強化）
- 匯出的原始明細只落在 `out/raw/`，**統計成功後自動刪除**；解析失敗才保留供比對格式，並明確警告。
- 最終報表只有分隊名稱與數字；`describeWorkbook` 的輸出經測試斷言不含任何資料列內容。
- 探測模式新增兩道保險：資料列表（列數 > 5 的表格）內元素一律跳過、5 碼以上連續數字遮蔽。

### 已驗證
- `npm run tool:ems:test`：14 項全數通過。
- 以合成的「含說明列」Excel 做端對端驗證：標題列定位、分隊計數、比率計算、
  Excel 報表寫出與讀回皆正確（120/80/30 案件對應 24/4/0 預警，比率 20.0%／5.0%／0.0%，合計 12.2%）。

### 待驗證
- 尚未對真實系統實跑。日期格式與匯出檔的分隊欄名以實跑結果為準，
  若欄名不在 `SQUAD_COLUMN_CANDIDATES` 內，程式會列出實際欄名並保留原始檔以便補上。

---

## 2026-07-26　v1.9.1 小工具改為雙擊捷徑執行

### 問題描述
使用者反映兩點：(1) 不想自己打指令，原以為工具是直接做在網站上；
(2) 辦公室電腦連 Python 都沒有，不確定能否安裝東西，並詢問 Node.js 是否為電腦內建。

### 說明與根本原因
- **網頁做不到自動抓取**：瀏覽器同源政策禁止網站登入並讀取另一個網域（emsdt.tyfd.gov.tw）的內容，
  這是瀏覽器的安全設計，任何網站都不行。唯一繞法是架伺服器代抓，但那等於把個案明細送上雲端，
  與使用者的個資要求牴觸，故不採用。
- **Node.js 並非 Windows 內建**，須自行安裝；使用者選擇在家中電腦執行（已有 v24.16.0），
  必要時遠端回家處理，因此保留全自動方案。
- 打指令這點屬實可改：改用與既有「啟動業務管理系統.bat」相同的雙擊捷徑模式。

### 修改的檔案與內容摘要
- 新增 `救護預警統計.bat`：日常使用；檢查 Node.js、缺套件自動 `npm install`、執行 `run`。
- 新增 `救護預警統計-設定用.bat`：探測模式專用，畫面明示「只記錄欄位名稱、不記錄個案資料、不截圖」。
  兩支批次檔沿用既有慣例維持純 ASCII 訊息，避免主控台中文亂碼。
- `tools/ems-report/logger.mjs`：`prompt` 由自行監聽 stdin 改用 `node:readline/promises`
  （經 .bat → npm → node 多層轉手時相容性較好）；並修正 **輸入串流結束（EOF）時
  等待中的 `question()` 永遠不會 resolve 而卡死** 的問題——改為與 `close` 事件競賽，
  EOF 回傳 `null`；新增 `closePrompt()` 讓程式能正常結束。
- `tools/ems-report/probe.mjs`：`prompt` 回傳 `null` 時視同結束，避免 EOF 下無限擷取迴圈。
- `tools/ems-report/index.mjs`：結束時呼叫 `closePrompt()`。
- `docs/SPEC.md`：4.3 節改以雙擊捷徑為主要執行方式，指令列列為等價寫法；目錄結構補上兩支 .bat。

### 已驗證
- 以 `printf 'abc\nq\n' | node` 模擬 EOF：第一次輸入正確取得 `abc`，串流結束後回傳 `null`
  並正常結束（exit 0），修正前會拋出 unsettled top-level await 並卡住。
- `npm run tool:ems:test` 4 項測試維持通過。

---

## 2026-07-26　v1.9 本機小工具（第一階段）：救護紀錄表查詢 — 到院前預警比率統計

### 需求描述
使用者要做「第一個小工具」：登入桃園市政府消防局緊急救護管理系統
（`https://emsdt.tyfd.gov.tw/EmmWeb/ActionControlServlet`）的報表系統，
查詢上個月 1 號 ~ 最後一天、救護狀態「已結案」的救護紀錄表，
分別匯出「全部」與「院前預警＝到院前傳送預警」兩份 Excel，
再比較各分隊的「到院前預警案件數 / 總案件數」比值。
使用者另特別要求：**過程牽涉個人資料，設計時務必不能讓個資外洩**。

### 設計決定與理由
1. **做成本機 CLI，不做在網頁上**：網站是 Firebase Hosting 的靜態前端，
   瀏覽器端受同源政策限制，本來就無法登入外部系統、處理驗證碼與下載檔案；
   更關鍵的是匯出檔含個案明細，放在本機處理才能保證不上雲。
2. **驗證碼由使用者本人輸入，不做自動辨識**：自動破解等於繞過該系統的防自動化機制，
   不做；改為有頭瀏覽器 + 輪詢等待登入完成，帳密可代填以減少打字。
3. **用 `playwright-core` + 本機 Chrome**：避免下載上百 MB 的 Chromium。
4. **先做探測模式**：目標系統為 Java `ActionControlServlet` 架構、全站 POST 導頁，
   登入後的頁面結構在無帳號的情況下無法取得，故先提供 `probe` 讓使用者實跑取得結構，
   再據以撰寫查詢與匯出步驟。

### 個資防護作法（寫入 SPEC 第 4.2 節）
- 全程本機執行：不寫入 Firestore、不呼叫外部 API、不上傳檔案。
- 原始匯出檔只落在 `tools/ems-report/out/raw/`，統計後自動刪除（`--keep-raw` 才保留）。
- 最終報表僅含分隊、案件數、預警數、比率，無任何個人欄位。
- `.gitignore` 排除 `tools/**/out/`，原始檔與報表都不會進版控。
- log 只印流程與筆數；帳號輸出前以 `maskAccount` 遮蔽。
- `probe` 只擷取欄位／按鈕／下拉選項名稱，**不擷取任何表格資料列、不截圖**。
- 帳密只讀 `tools/ems-report/.env`（已 gitignore），並明文禁用 `VITE_` 前綴，
  避免誤放進根目錄 `.env` 而被 Vite 打包進公開的前端檔案。

### 修改的檔案與內容摘要
- 新增 `tools/ems-report/config.mjs`：網址、登入欄位選擇器、瀏覽器設定、輸出路徑、查詢條件文字。
- 新增 `tools/ems-report/dateRange.mjs`：`getMonthRange` / `getPreviousMonthRange` /
  `resolveMonthRange` / `formatDateForSite`，皆為純函式。
- 新增 `tools/ems-report/dateRange.test.mjs`：4 組 node:test 測試（含閏年、跨年、格式錯誤）。
- 新增 `tools/ems-report/session.mjs`：啟動本機 Chrome、代填帳密、輪詢等待登入完成
  （驗證碼打錯退回登入頁時會自動再補帳密）。
- 新增 `tools/ems-report/probe.mjs`：互動式頁面結構探測，逐 frame 擷取連結／輸入框／下拉／按鈕／表頭。
- 新增 `tools/ems-report/logger.mjs`：分階段輸出、錯誤含階段名稱、`maskAccount` 帳號遮蔽、終端機 prompt。
- 新增 `tools/ems-report/index.mjs`：CLI 進入點（`probe` / `run`，支援 `--month=` 與 `--keep-raw`）。
- 新增 `tools/ems-report/README.md`、`.env.example`。
- `.gitignore`：新增 `tools/**/out/`。
- `package.json`：新增 `tool:ems`、`tool:ems:test` 指令與 `playwright-core` 開發依賴；版本 → 1.9.0。
- `src/pages/ToolsPage.tsx`：由「保留區域」改為工具說明頁，載明本機執行與個資不上雲的理由。
- `docs/SPEC.md`：新增第 4 章「本機小工具」（目的、個資規範、指令、流程、模組職責、進度），
  原第 4~6 章順延為 5~7 章；路由表 `/tools` 說明、目錄結構、檔頭版本行同步更新。

### 已驗證
- `npm run tool:ems:test`：4 項測試全數通過。
- 以 headless Chrome 實連目標站：登入頁四個選擇器（帳號／密碼／驗證碼／登入鈕）皆各命中 1 個元素。

### 待辦（第二、三階段）
- 需使用者實跑 `npm run tool:ems -- probe` 取得「報表系統 → 救護紀錄表查詢」的實際頁面結構，
  才能實作日期填入、進階搜尋、匯出 Excel 與分隊彙總。目前執行 `run` 會明確報錯提示此事。

---

## 2026-07-26　v1.8.1 屬性與待辦公版的刪除一併限管理員

### 需求描述
v1.8 只鎖了「刪除業務」，使用者確認實測正常後要求：**屬性管理與待辦公版的刪除也要鎖成只有管理員能做**。

### 根本原因
需求變更（非缺陷）：v1.8 依當時指示僅鎖業務刪除，屬性與公版為共用設定，
一般使用者誤刪會影響所有人（刪屬性還會連帶把底下業務批次轉移），故一併收緊。

### 修改的檔案與內容摘要
- `firebase/firestore.rules`：`categories` 與 `checklistTemplates` 由 `allow update, delete: if isApproved()`
  拆為 `allow update: if isApproved()` + `allow delete: if isAdmin()`；檔頭權限模型註解同步更新。
- `src/lib/permissions.ts`：新增純函式 `canDeleteCategory`、`canDeleteTemplate`（皆等同 isAdmin）。
- `src/pages/CategoriesPage.tsx`：由 `useAuth()` 取得 isAdmin，透過新增的 `canDelete` prop 傳入
  `SortableCategoryRow`；非管理員不顯示「刪除」按鈕（改名、拖曳排序、新增不受影響）。
- `src/pages/ChecklistTemplatesPage.tsx`：同上，`TemplateCard` 新增 `canDelete` prop，
  非管理員不顯示「刪除」公版按鈕（改名、加項目、改項目、刪項目、拖曳排序不受影響）。
- `scripts/rules.test.mjs`：補上「管理員可刪除屬性」「成員不可刪除屬性」「成員可編輯公版」
  「成員不可刪除公版」四項測試，並在預置資料加入 cat-2 與 tpl-1。
- `package.json`：版本 `1.8.0` → `1.8.1`。

### 規格外決定
- 公版內「單一項目」的新增/修改/刪除仍屬編輯（Firestore 的 update），一般使用者可操作；
  受限的是刪除整份公版。若日後也要鎖項目層級，需改為由規則比對 items 陣列長度或改資料結構。

### 驗收
- `npm run build` 零錯誤；規則以 `firebase deploy` 編譯通過並發布。
- 線上實測（臨時非管理員帳號）：待審核者對 categories / checklistTemplates 的刪除皆回 403。

---

## 2026-07-25　v1.8 登入管制：帳號審核制 + 角色權限 + 資料改為多人共用

### 需求描述
1. **登入要有管制、要有使用者權限**。
2. 管理員為 `seansu1220@gmail.com`（權限最大）；其他人註冊後**必須經管理員允許才能成為正式帳號**。
3. 兩種帳號的差別：**只有管理員能刪除業務**，其他人不行。
4. 使用者補充：目前主要仍是他個人的業務，但同事代理時要能「點進來看他有什麼待辦、幫他新增業務」，
   故**資料為大家共用同一批**（未來擴充多人再調整邏輯）。

### 根本原因
需求變更（非缺陷）：原系統設計為「單一使用者、多裝置」，所有資料以 `ownerUid` 做硬隔離
（每個帳號只看得到自己的資料），既無角色概念，也無註冊審核；任何人都能自行註冊直接使用，
且任何人都能刪除自己看得到的業務。

### 修改的檔案與內容摘要

**A. 型別與設定（型別先行 / 配置驅動）**
- `src/types/user.ts`：新增 `UserRole`（admin | member）、`UserStatus`（pending | approved | rejected）；
  `AppUser` 新增 `role`、`status`、`reviewedAt`、`reviewedBy`。
- `src/config/constants.ts`：新增 `ADMIN_EMAILS`（管理員 email 白名單，註明須與 firestore.rules 同步）、
  `USER_STATUS_LABELS`（中文標籤 + 色調）、`USER_ROLE_LABELS`。
- `src/lib/permissions.ts`（新增，純函式）：`isAdminEmail`、`resolveRole`、`resolveInitialStatus`、
  `isAdmin`、`isApproved`、`canDeleteTask`、`canManageUsers`；管理員一律以 **email 白名單**認定，
  不看資料庫欄位（避免竄改文件提權）。

**B. 帳號審核流程**
- `src/services/authService.ts`：`ensureUserDoc` 建立文件時依 email 決定 `role/status`
  （管理員 → admin/approved；其他人 → member/**pending**），已有 status 則不覆寫；
  舊資料（無 status）自動補寫。`register` 同步寫入 role/status。
  新增 `subscribeUserProfile`（即時訂閱自己的帳號文件）、`mapUserData`（舊資料相容推導）。
- `src/context/AuthProvider.tsx`：改用 `subscribeUserProfile` **即時訂閱**——管理員核准後，
  待審核者的畫面自動解鎖，不需重新登入；`ensureDefaultCategories` 僅在帳號已核准時才呼叫
  （待審核帳號碰 categories 會被規則擋下）；context 新增 `isAdmin`、`isApproved` 兩個衍生旗標。
- `src/context/authContext.ts`：`AuthContextValue` 新增 `isAdmin`、`isApproved`。
- `src/components/ProtectedRoute.tsx`：未核准者顯示 `PendingApprovalPage`，不進入系統、不載入任何業務資料。
- `src/pages/PendingApprovalPage.tsx`（新增）：待審核 / 未通過的提示畫面（含帳號資訊與登出）。
- `src/pages/RegisterPage.tsx`：註冊表單上方加註「新帳號需經管理員核准後才能使用」。
- `src/services/userService.ts`（新增）：`subscribeUsers`（待審核排最前）、`setUserStatus`（核准/拒絕，
  記錄 reviewedAt / reviewedBy）。
- `src/pages/UsersPage.tsx`（新增）：`/users` 使用者管理頁（僅管理員，非管理員導回首頁）——
  帳號清單、狀態徽章、核准 / 停用（二次確認）、待審核數量提醒；管理員帳號不可在此調整。
- `src/App.tsx`、`src/components/Layout.tsx`：新增 `/users` 路由；導覽列「使用者管理」僅管理員可見，
  右上角顯示名稱後加「（管理員）」。

**C. 資料由「各自隔離」改為「全體共用」**
- `src/services/taskService.ts`、`categoryService.ts`、`checklistTemplateService.ts`：
  訂閱查詢移除 `where('ownerUid','==',uid)`（改讀整個集合），對應簽名去掉 ownerUid 參數；
  `countTasksInCategory` / `reassignTasksCategory` 同步移除 ownerUid 條件；
  `ensureDefaultCategories` 改為「整個集合為空」才建立（避免第二位使用者登入時重複建立預設屬性）。
  `ownerUid` 欄位保留，語意改為「**建立者**」並於檔頭註明。
- `src/hooks/useTasks.ts`、`useCategories.ts`、`useChecklistTemplates.ts`：配合新簽名。
- `src/pages/CategoriesPage.tsx`：配合新簽名。
- `src/pages/TaskDetailPage.tsx`：**刪除業務卡片僅管理員可見**；表單的 `ownerUid` 改傳「目前登入者」
  （原本傳業務建立者，會導致同事在他人業務內新增屬性時被規則擋下）。
- `src/components/ChecklistTemplateBar.tsx`：「另存為公版」的建立者改為目前登入者（同上原因）。

**D. 安全規則（權限最終防線）**
- `firebase/firestore.rules`：改寫。`isAdmin()` 以 `request.auth.token.email` 比對白名單；
  `isApproved()` = 管理員 or 自己的 users 文件 `status == 'approved'`；
  tasks/categories/checklistTemplates 讀取與更新須已核准、建立強制 `ownerUid == uid`、
  **tasks 的 delete 僅管理員**；users 拆成 `get`（本人或管理員）與 `list`（僅管理員），
  建立時強制 role/status 依 email 決定，更新時**本人不可改自己的 role/status**（不可自我核准）。
- `scripts/rules.test.mjs`（新增）：涵蓋管理員 / 成員 / 待審核 / 未登入 / 自我提權共 20 項規則測試。

### 規格外決定
- 管理員判定用 **email 白名單**而非 users 文件的 role 欄位：即使有人竄改自己的文件也無法提權；
  代價是白名單需在 `constants.ts` 與 `firestore.rules` 兩處手動同步（兩處皆已加註警語）。
- 管理員在 `isApproved()` 中短路（不查文件），確保即使自己的 users 文件缺欄位也不會被鎖在系統外。
- 屬性與待辦公版的**刪除未限管理員**（使用者只要求鎖「刪除業務」）；日後要收緊只需改規則與 permissions.ts。
- 帳號被停用（rejected）只擋登入使用，**不刪除**其建立的資料。
- 前端判斷管理員時，email 一律取自 Firebase 登入資訊（與安全規則使用的 token email 同源），
  不用 users 文件內的 email 欄位，避免舊文件欄位缺漏導致管理員被誤判為一般使用者。

### 驗收
- `npx tsc -b` 型別檢查零錯誤；`npm run build` 零錯誤（僅 bundle 體積 >500kB 常規警告）。
- `scripts/rules.test.mjs` **尚未實際執行**：firebase-tools 15 的模擬器需 JDK 21，本機僅有 Java 8
  （為避免影響本機既有 Java 環境未安裝新 JDK）。
- 改以**線上實測**替代：部署後以臨時測試帳號（非管理員）直接呼叫 Firestore REST API 實測 8 項，全數通過——
  可建立自己的 pending 文件 ✅／讀不到業務清單（403）✅／不可新增業務（403）✅／不可自我核准（403）✅／
  不可自我提權為 admin（403）✅／不可列出使用者清單（403）✅／可讀自己的文件 ✅／可改自己的顯示名稱 ✅。
  測試後已刪除該 Auth 帳號與其 Firestore 文件。
- **尚未實測**：「已核准的一般使用者」路徑（需管理員核准一個帳號才能測），
  待第一位同事註冊並核准後確認；規則上僅差 `status == 'approved'` 的字串比對。

---

## 2026-07-25　v1.7 說明欄加大 + 待辦流程控管（編輯期限/拖曳排序/進度）+ 待辦公版

### 需求描述
1. **業務詳情的「業務說明」欄位太小**，輸入長內容不好看也不好編輯。
2. **多流程業務（如標案）需要控管**：使用者希望把流程列成待辦事項逐項打勾，
   但一開始不知道各關卡期限，**待辦必須能事後編輯期限**。
3. **待辦公版**：能把做過的一套流程存成公版，之後新增業務時自動匯入成待辦，不必每次重打。

### 根本原因
需求變更（非缺陷）：
- 說明欄原為 `rows={3}` 且未開放調整高度。
- 原待辦（v1.1 起）只能新增/勾選/刪除，**無法編輯**，排序固定依期限，
  無法表達「流程先後」，也沒有整體完成度視覺回饋。
- 系統原無範本概念，重複性流程需逐筆重打。

### 修改的檔案與內容摘要

**功能 A：業務說明欄位加大**
- `src/components/ui.tsx`：新增 `TEXTAREA_CLASS`（＝`INPUT_CLASS` + `resize-y leading-relaxed`），
  多行欄位可自行拖曳右下角調整高度。
- `src/components/TaskForm.tsx`：業務說明 `rows` 3 → 10、備註 2 → 4，兩者改用 `TEXTAREA_CLASS`。
- `src/components/CompletionSection.tsx`：完成說明 `rows` 2 → 3、改用 `TEXTAREA_CLASS`。

**功能 B：待辦事項強化（多流程業務控管）**
- `src/types/task.ts`：`ChecklistItem` 新增 `sortOrder: number`（流程順序）。
- `src/lib/checklistLogic.ts`（新增，純函式）：`ChecklistSortMode`（'custom' | 'deadline'）與
  `CHECKLIST_SORT_MODES` 標籤配置；`withChecklistOrder`（舊資料無 sortOrder 時以索引遞補）、
  `nextChecklistSortOrder`、`sortChecklistItems(items, mode)`、`checklistProgress`（total/done/percent）、
  `checklistDeadlineToneClass`（逾期紅 / urgent 橙 / 其餘灰，沿用 `REMINDER_DAYS.urgent`）。
- `src/services/taskService.ts`：
  - `mapTaskData` 以 `withChecklistOrder` 補 sortOrder（舊資料相容）。
  - `buildChecklistItem` 加 `sortOrder`；`addChecklistItem` 以 `nextChecklistSortOrder` 接在最後。
  - 新增 `updateChecklistItem(existing, itemId, {content, deadline})`——編輯內容與期限
    （期限可由 null 補上，或清空回 null），不動勾選狀態與順序。
  - 新增 `reorderChecklistItems(existing, orderedIds)`——依給定順序重寫 sortOrder（0..n-1）。
- `src/components/ChecklistSection.tsx`：改寫。上方顯示**完成進度條**（已完成 N / 總數 + 百分比）；
  新增**排序模式切換**（流程順序 / 依期限）；「流程順序」模式且未鎖定、未編輯中時可**拖曳把手**排序
  （@dnd-kit，桌機滑鼠 5px、手機長按 200ms；本地 state 樂觀更新，失敗還原）；
  每列新增「編輯」進入行內編輯（內容 input + 期限 date + 儲存/取消）；
  無期限未勾項目顯示灰字「未定期限」；列拆為子元件 `ChecklistRow`（`useSortable`）。

**功能 C：待辦公版（範本）**
- `src/types/checklistTemplate.ts`（新增）：`ChecklistTemplateItem { id, content, sortOrder }`、
  `ChecklistTemplate { id, name, items, ownerUid, createdAt, updatedAt }`。
- `src/config/constants.ts`：`COLLECTIONS` 新增 `checklistTemplates`。
- `firebase/firestore.rules`：新增 `checklistTemplates/{templateId}` 規則（比照 tasks，僅 ownerUid 本人可存取）。
- `src/services/checklistTemplateService.ts`（新增）：`subscribeChecklistTemplates`（依名稱排序）、
  `createChecklistTemplate(name, contents, ownerUid)`、`renameChecklistTemplate`、
  `updateChecklistTemplateItems`（覆寫整份項目並重編 sortOrder 為 0..n-1）、`deleteChecklistTemplate`、
  `buildTemplateItems`；讀取時對缺 sortOrder 的項目以索引遞補。
- `src/hooks/useChecklistTemplates.ts`（新增）：比照 `useCategories` 的訂閱 hook。
- `src/services/taskService.ts`：新增 `buildChecklistItemsFromTemplate(templateItems, startSortOrder)`
  （期限一律 null）、`appendChecklistFromTemplate(existing, template)`（附加至現有待辦之後，
  空公版擋下並回中文錯誤）、`extractChecklistContents(existing)`（依流程順序取內容，供另存公版）；
  `createTask` 新增第三參數 `initialChecklistItems`（預設 `[]`）。
- `src/components/ChecklistTemplateBar.tsx`（新增）：待辦區塊上方工具列——選公版「套用公版」（二次確認）、
  「另存為公版」（名稱擋空白與重複、無待辦時擋下），並連結至 `/templates`。
- `src/pages/ChecklistTemplatesPage.tsx`（新增）：`/templates` 公版管理頁——新增/改名/刪除公版，
  公版項目可新增、就地改內容、刪除、拖曳排序（子元件 `TemplateCard`、`SortableTemplateItemRow`）。
- `src/pages/NewTaskPage.tsx`：新增「待辦公版」下拉（有公版時才顯示），建立業務時帶入初始待辦。
- `src/App.tsx`：新增受保護路由 `templates`；`src/components/Layout.tsx`：導覽列加「待辦公版」。
- `package.json`：版本 `1.6.0` → `1.7.0`。

### 規格外決定
- 「流程順序」模式下**已勾選項目不移到最後**（維持流程先後的閱讀順序）；「依期限」模式才把已勾項目排最後。
- 公版**不含期限欄位**（含相對天數亦未實作）：使用者建立流程時通常尚未確定各關卡日期，
  套用後於待辦列以「編輯」逐項補期限。
- 套用公版採**附加**而非覆蓋，避免誤刪既有待辦。

### 驗收
- `npm run build`（tsc -b && vite build）零錯誤（僅 bundle 體積 >500kB 常規警告）。
- 舊資料相容：既有待辦無 `sortOrder` 時以陣列索引遞補，不需資料遷移。
- **注意**：新集合 `checklistTemplates` 的安全規則需部署後才可使用（`npx firebase-tools deploy`）。

---

## 2026-07-24　v1.6 版本號顯示 + 小工具區改為保留區域

### 需求描述
1. **右上角顯示版本號**：使用者無法確認線上是否為最新版本，需在頁面右上角標註版本號（滑過顯示建置時間），確保有載入到最新版本。
2. **小工具區暫緩實作**：使用者希望先「保留區域」，待內部系統匯出規格確定後再評估作法，故移除先前的「表格轉 Excel」工具與 xlsx 依賴。

### 根本原因
需求變更（非缺陷）：v1.5 僅 commit 未部署，使用者線上看不到新版；且需一個可視的版本標記自我驗證。小工具的實際工具尚無確定規格。

### 修改的檔案與內容摘要
- `package.json`：版本號 `0.1.0` → `1.6.0`；移除 `xlsx` 依賴（bundle 由 ~1.15MB 降至 ~816KB）。
- `vite.config.ts`：建置期由 package.json 讀版本號、記錄建置時間，以 `define` 注入全域常數 `__APP_VERSION__`、`__BUILD_TIME__`。
- `src/vite-env.d.ts`：宣告上述兩個注入常數的型別。
- `src/config/constants.ts`：新增 `APP_VERSION`、`APP_BUILD_TIME`（ISO → 本地 yyyy-MM-dd HH:mm）。
- `src/components/Layout.tsx`：導覽列右側顯示 `v<版本>`（等寬字、灰色，title 顯示建置時間）。
- `src/pages/ToolsPage.tsx`：改寫為「保留區域」，僅列出規劃中的工具佔位卡（配置驅動的 `PLANNED_TOOLS`）。
- `src/lib/tableParse.ts`：移除（隨表格轉 Excel 工具一併移除）。

---

## 2026-07-24　v1.5 定期業務 + 小工具區（表格轉 Excel）

### 需求描述
兩項新功能：
1. **定期業務（週期性業務）**：業務可設定週期規則（每月固定日 / 每週固定星期 / 每 N 天 / 每年固定日期）。
   完成一期後同一筆業務的期限自動跳至下一期，並在進度紀錄自動寫一筆「本期完成」，歷史都留在同一張卡。
2. **小工具區**：新增 `/tools` 頁面，第一個工具「表格轉 Excel」——貼上從網頁 / 內部系統複製的表格文字即可匯出 .xlsx；
   另放一張「內部系統資料匯出（規劃中）」佔位卡。

### 根本原因
需求變更（非缺陷）：原 `Task` 僅支援單次 `deadline`，無法表達週期性業務；使用者另需一個匯出小工具集中區。

### 修改的檔案與內容摘要

**功能 A：定期業務**
- `src/types/task.ts`：新增可辨識聯集 `RecurrenceRule`（monthly/weekly/everyNDays/yearly）；
  `Task` 與 `TaskDraft` 各新增 `recurrence: RecurrenceRule | null`。
- `src/lib/recurrence.ts`（新增，純函式）：`nextOccurrence(rule, fromDate, {inclusive})` 回傳下一個週期日
  （monthly/yearly 以字串比較決定當期或次期、day 超界夾為月底、2/29 平年夾 2/28；weekly 取下一個該星期幾；
  everyNDays 一律 `addDaysToDate(fromDate, n)`）；`describeRecurrence(rule)` 中文描述；`isRecurring(task)`。
  日期運算重用 `taskLogic.addDaysToDate`（以 `T00:00:00` 建本地日期避免時區偏移）。
- `src/services/taskService.ts`：`mapTaskData` 加 `recurrence: data.recurrence ?? null`（舊資料相容）；
  新增 `completeRecurringCycle(existing, {date,time,note})`——單次 `updateDoc` 同時 append「本期完成 / 本期完成：<note>」
  進度並將 `deadline` 更新為 `nextOccurrence`（起算基準取現有期限與完成日期較大者），不設 completed；
  `recurrence` 為 null 時 throw 中文錯誤（標明位置）。
- `src/components/TaskForm.tsx`：`buildInitialDraft` 加 `recurrence`；新增「週期」區塊
  （select 型別 + 依選擇顯示 monthly 日 / weekly 星期 / everyNDays 天數 / yearly 月+日 輸入）；
  週期參數以字串狀態管理、送出時 `resolveRecurrence` 驗證（空 / 非正整數 / 超界擋下並顯示中文錯誤）；
  選了週期但期限留空時自動帶入 `nextOccurrence(rule, today(), {inclusive:true})`，並顯示提示小字；展期流程一併帶入週期。
- `src/components/CompletionSection.tsx`：依 `task.recurrence` 分流——定期業務主按鈕「完成本期」
  （`completeRecurringCycle`，confirm 說明期限將跳下一期，成功後清空 note、date/time 重設）＋次要 ghost 按鈕
  「結束定期並鎖定」（走原 `completeTask`）；單次業務維持原「標記完成」。
- `src/pages/TaskDetailPage.tsx`：`TaskForm` 的 initial 帶入 `recurrence`；完成卡標題 / 說明依是否定期切換文案。
- `src/lib/taskLogic.ts`：`ReminderItem` 新增選填 `recurrenceLabel?`；`getReminderTasks` 對 kind='task' 且
  定期業務帶入 `describeRecurrence` 結果（排序不變）。
- `src/pages/HomePage.tsx`、`src/components/ReminderPanel.tsx`：定期業務 / 提醒項顯示紫色（violet）「定期」徽章，
  HomePage 後綴顯示週期描述、ReminderPanel 以 title tooltip 顯示。

**功能 B：小工具區**
- `package.json`：新增依賴 `xlsx`（SheetJS 官方 CDN tarball `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`，
  版本 0.20.3；官方 registry 已停更，故用 CDN 版）。
- `src/lib/tableParse.ts`（新增，純函式）：`parseClipboardTable(text)` 依換行拆列（去尾端空列）、
  有 Tab 以 \t 拆欄，否則多數列含逗號時以逗號做簡易 CSV 拆（不處理引號跳脫，已註明限制），其餘每列單欄。
- `src/pages/ToolsPage.tsx`（新增）：頁首「小工具」；卡片一「表格轉 Excel」（可展開收合、貼上 textarea 為 monospace、
  前 20 列預覽 + 欄列統計、檔名輸入預設「匯出資料」、`XLSX.utils.aoa_to_sheet` + `XLSX.writeFile` 匯出、
  空資料 / 例外以 `ErrorBanner` 顯示）；卡片二「內部系統資料匯出（規劃中）」灰色佔位。
- `src/App.tsx`：受保護路由新增 `tools`；`src/components/Layout.tsx`：導覽列「屬性管理」後加「小工具」NavLink。

### 規格外決定
- `RecurrenceRule` 的 monthly `day` 於當月超界（如 2 月選 31 號）時，`nextOccurrence` 夾為該月最後一天，
  對應每年 2/29 於平年夾為 2/28；此為 SPEC 所要求的邊界處理，於此明記。
- 「定期」徽章使用 Tailwind violet 色系；因既有 `Badge` 元件的 `Tone` 未含 purple/violet，改以行內 `<span>` 呈現
  （比照 ReminderPanel 既有「待辦」藍色徽章寫法），未擴充 `Tone` 型別以免影響其他元件。
- xlsx 併入主 bundle 使其體積增大（>500kB 警告仍為常規警告，非錯誤）；未另做 code-split。

### 驗收
- `npm install`（xlsx 0.20.3 自 SheetJS CDN）成功；`npm run build`（tsc -b && vite build）零錯誤
  （僅 bundle 體積 >500kB 常規警告）。

---

## 2026-07-23　v1.4 無期限業務永遠顯示於提醒與列表頂端

### 問題描述
依 SPEC v1.4（2.2 節）：無期限的未完成業務容易被埋沒，需保證它們永遠曝光——
（1）首頁提醒卡永遠顯示無期限未完成業務（不受 7/30 天視窗限制），
（2）業務列表未完成之中將無期限者排到最上面。

### 根本原因
需求變更（非缺陷）：原邏輯將無期限業務排在最後或排除於提醒之外，
使用者反映這類「沒設期限」的業務反而最容易被遺忘，故調整為優先曝光。

### 修改的檔案與內容摘要
- `src/lib/taskLogic.ts`：
  - `ReminderItem.deadline` 型別由 `string` 改為 `string | null`（無期限業務為 null）。
  - `getReminderTasks`：未完成且無期限（deadline===null）的業務一律納入（kind='task'，
    不受 withinDays 限制）；排序改為有期限者在前（近到遠），無期限者集中排最後。
    待辦（checklist）來源邏輯不變（仍只納入未勾且有期限者）。
  - `sortTasks`：未完成之中改為「無期限在前 → 依期限近到遠 → 再依 updatedAt 新到舊」；
    已完成群組維持原規則（有期限近到遠、無期限最後）。以 doneA 判斷方向。
- `src/components/ReminderPanel.tsx`：
  - 將提醒拆為「有期限」與「無期限」兩段；無期限段以細分隔線 + 小標題「未定期限」區隔，
    排在有期限段之後，每筆以灰色「未定期限」徽章取代日期與剩餘天數欄位。
  - 抽出共用子元件 `ReminderTitle`（名稱 + 待辦徽章 + 屬性標籤）供兩段使用。
  - 有期限項目的顏色規則與「展開 30 天」切換行為不變；空狀態沿用 `reminders.length===0`
    判斷（無期限項目已計入陣列，有項目時不算空）。

---

## 2026-07-23　v1.3 屬性排序改拖曳

### 問題描述
依 SPEC v1.3（2.4 節）將屬性管理頁 `/categories` 的排序方式，
由「上移 ↑ / 下移 ↓」按鈕改為拖曳排序：桌機滑鼠拖曳、手機長按拖曳，
每列前方設拖曳把手，放開後依新順序批次寫入 `sortOrder`（0..n-1）。

### 根本原因
需求變更（非缺陷）：使用者調整排序操作模型，改用直覺的拖曳取代逐格移動。

### 修改的檔案與內容摘要
- `package.json`：新增依賴 `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`。
- `src/services/categoryService.ts`：移除 `swapCategoryOrder`（上移/下移用），
  新增 `reorderCategories(orderedIds: string[])`——以 `writeBatch` 將每筆屬性的
  `sortOrder` 依陣列索引重寫為 0..n-1，try-catch 中文錯誤含函式位置。
- `src/pages/CategoriesPage.tsx`：移除上移/下移按鈕與 `handleMove`、`IconButton`；
  以 `DndContext` + `SortableContext`（`verticalListSortingStrategy`）包住清單，
  抽出 `SortableCategoryRow` 元件（`useSortable`），每列加拖曳把手
  （⠿ 圖示、觸控目標 40px、`touch-none`、`cursor-grab`）。
  感測器：`PointerSensor`（distance 5）＋ `TouchSensor`（delay 200ms、tolerance 8），
  手機長按 200ms 才啟動拖曳以避免與捲動衝突。
  新增本地順序 state `orderedCategories`：`onDragEnd` 以 `arrayMove` 算新順序後
  樂觀更新畫面，再呼叫 `reorderCategories`；失敗顯示中文錯誤並還原為訂閱資料順序。
  以 `useEffect` 在「非拖曳且非儲存中」時才與 `useCategories` 即時訂閱同步，
  避免 Firestore 寫入回波把畫面閃回舊順序。改名／刪除／新增等既有功能維持不變。

### 驗收
- `npm install` 成功新增 4 個套件；`npm run build`（tsc -b && vite build）零錯誤
  （僅 Firebase bundle 體積 > 500kB 常規警告）。

---

## 2026-07-23　v1.2 功能調整與儲存按鈕修正

### 問題描述
依 SPEC v1.2 進行六項變更：
1. 進度紀錄新增「時間（時:分）」欄位，並調整排序（日期新→舊、同日時間新→舊、無時間排該日最後）。
2. 勾選待辦（false→true）時跳出確認框，可將該待辦一併寫入進度紀錄。
3. 完成區塊新增「完成時間（時:分）」，詳情頁已完成橫幅顯示「完成日期＋時間」。
4. 修正「儲存變更」按鈕成功後仍卡在「儲存中」的 bug，並新增「已儲存」提示。
5. 待辦清單已勾項目預設隱藏，底部提供「顯示已完成（N）」切換。
6. 期限新增「展期」按鈕（+1/+3/+7 天與自訂天數），確認後立即儲存整張表單。

### 根本原因
1、2、3、5、6 為需求變更（非缺陷）：使用者調整進度/待辦/完成的操作模型與時間顆粒度。
4 為缺陷：`TaskForm.handleSubmit` 僅在 catch 分支 `setSubmitting(false)`，成功路徑未重設 submitting 狀態，導致送出成功後按鈕永久停留在「儲存中」。

### 修改的檔案與內容摘要
- `src/types/task.ts`：`ProgressEntry` 新增 `time: string | null`；`Task` 新增 `completionTime: string | null`。
- `src/lib/taskLogic.ts`：新增純函式 `nowTime()`（當下 HH:mm）、`addDaysToDate(dateStr, days)`（字串安全加日、避免時區偏移）、
  `sortProgressEntries(entries)`（日期→時間→createdAt 排序，共用於 ProgressSection 與 HomePage）。
- `src/services/taskService.ts`：mapping 對舊資料 `progressEntries[].time` 與 `completionTime` 預設 null；
  `buildProgressEntry`/`addProgressEntry` 加入 time；`completeTask` 簽名新增 `completionTime`；
  新增 `completeChecklistItemWithProgress`（同一次 updateDoc 寫入 done=true 與一筆「完成待辦：…」進度）；
  `reopenTask` 維持不清 completionTime；createTask payload 補 `completionTime: null`。
- `src/components/ProgressSection.tsx`：新增列加 `<input type="time">`（可空）；改用 `sortProgressEntries`；顯示「日期 時間」。
- `src/components/ChecklistSection.tsx`：勾選（false→true）跳 `window.confirm`，確定走 `completeChecklistItemWithProgress`、
  取消走 `toggleChecklistItem`；取消勾選（true→false）不跳框；已勾項目預設隱藏，底部「顯示已完成（N）」切換。
- `src/components/CompletionSection.tsx`：新增「完成時間」`<input type="time">`（預設 `nowTime()`、可空），傳入 `completeTask`。
- `src/components/TaskForm.tsx`：修正成功路徑 `setSubmitting(false)` 並顯示 2 秒「已儲存」提示（useRef 計時器＋unmount clearTimeout）；
  重構 `submitDraft` 共用驗證/送出；新增 `showExtend` prop 與期限「展期」行內選單（快選/自訂天數→addDaysToDate→立即送出）。
- `src/pages/TaskDetailPage.tsx`：`TaskForm` 傳入 `showExtend`；已完成橫幅顯示完成日期＋時間。
- `src/pages/HomePage.tsx`：最新進度摘要改用 `sortProgressEntries`。

---

## 2026-07-23　v1.1 功能調整

### 問題描述
依 SPEC v1.1 進行四項需求變更：
1. 移除「優先度 priority」與「狀態 status」欄位，業務只分「進行中 / 已完成」。
2. 業務表單屬性下拉可即時新增屬性並自動選取。
3. 業務詳情頁新增「待辦事項（checklist）」區塊（獨立於進度紀錄）。
4. 業務詳情頁新增「完成區塊」＋完成後整筆鎖定；首頁提醒卡納入未勾掉的待辦事項。

### 根本原因
需求變更（非缺陷修正）：使用者調整業務管理模型，改以待辦清單與完成鎖定取代優先度/狀態。

### 修改的檔案與內容摘要
- `src/types/task.ts`：刪除 `TaskPriority`/`TaskStatus`，`Task`/`TaskDraft` 移除 priority/status；
  新增 `ChecklistItem` 型別與 `Task` 的 `checklistItems`、`completed`、`completionDate`、`completionNote`。
- `src/config/constants.ts`：刪除優先度/狀態選項、`DONE_STATUS`、`DEFAULT_PRIORITY`、`DEFAULT_STATUS`、
  `getPriorityOption`/`getStatusOption`、`Option` 型別；保留 `Tone`。
- `src/lib/taskLogic.ts`：`isDone` 改判斷 `task.completed`；新增 `ReminderItem` 型別；
  `getReminderTasks` 改回傳 `ReminderItem[]`（來源＝未完成業務期限＋未完成業務中未勾且有期限的待辦）。
- `src/services/taskService.ts`：mapping 對舊資料相容（`completed` 取 `data.completed ?? (data.status === 'done')`、
  checklistItems 預設 []、completionDate 預設 null、completionNote 預設 ''）；寫入不再含 priority/status；
  `updateTask` 移除 prevStatus 參數；新增 `addChecklistItem`/`toggleChecklistItem`/`removeChecklistItem`、
  `completeTask`、`reopenTask`。
- `src/components/TaskForm.tsx`：移除優先度/狀態欄位；屬性下拉新增「＋ 新增屬性…」行內建立
  （擋空白/重複、sortOrder 取最大值+1、帶入 ownerUid、成功後自動選取）；新增 `disabled` 鎖定與 `ownerUid` prop。
- `src/components/ProgressSection.tsx`：新增 `locked` prop，鎖定時隱藏新增/刪除。
- `src/components/ChecklistSection.tsx`（新增）：待辦清單新增/勾選/刪除，未勾在前（期限近到遠、無期限在後）、
  已勾在後（刪除線淡色）；逾期紅、urgent 天數內橙。
- `src/components/CompletionSection.tsx`（新增）：完成日期（預設今天）＋完成說明＋「標記完成」（二次確認）。
- `src/components/ReminderPanel.tsx`：改用 `ReminderItem`；待辦項顯示「待辦」徽章與所屬業務名稱，點擊跳轉業務。
- `src/pages/HomePage.tsx`：TaskRow 移除優先度/狀態徽章，改顯示「已完成」徽章與未完成待辦數（待辦 N）。
- `src/pages/TaskDetailPage.tsx`：`updateTask` 改兩參數；新增待辦與完成區塊；完成後鎖定
  （表單/進度/待辦停用、隱藏刪除與完成區塊、頂部綠色已完成橫幅＋「解除完成」二次確認）；傳入 ownerUid。
- `src/pages/NewTaskPage.tsx`：`TaskForm` 傳入 `ownerUid={user.uid}`。

### 與規格不同的決定
- 完成表單另拆為獨立元件 `CompletionSection.tsx`（SPEC 僅明列 ChecklistSection），
  以符合單一職責、與 ProgressSection 風格一致，未影響規格行為。

### 驗收
- `npm run build`（tsc -b && vite build）零錯誤（僅 Firebase bundle 體積 > 500kB 常規警告）。
- 全案搜尋確認 priority/status 僅剩 taskService 舊資料相容 mapping 與其註解。

---

## 2026-07-23　修正首次登入被誤判為未登入的競態問題

### 問題描述
啟用 Authentication 後仍無法登入：登入成功卻停在登入頁（F12 的
Cross-Origin-Opener-Policy 警告為 Firebase SDK 已知無害訊息，非原因）。

### 根本原因
登入成功瞬間 `onAuthStateChanged` 先觸發並讀取 `users/{uid}` 文件，
但首次登入時該文件是在登入「之後」才由 register/loginWithGoogle 建立，
讀到 null → `setUser(null)` → ProtectedRoute/LoginPage 判定未登入而踢回登入頁。

### 修改的檔案與內容
- `src/services/authService.ts`：`ensureUserDoc` 改為 export，供 AuthProvider 使用。
- `src/context/AuthProvider.tsx`：登入狀態變化時先 `ensureUserDoc` 再讀 profile；
  讀不到時以 Firebase 登入資訊組備援 profile，不再誤判未登入；
  `ensureDefaultCategories` 改用 uid 直接呼叫並獨立 try-catch（失敗不影響登入）。

### 驗收
- `npm run build` 零錯誤；已重新部署 Hosting。
- Email 註冊 API 實測正常（建立測試帳號後即刪除）；COOP 標頭確認部署正確。

---

## 2026-07-22　Firebase 專案建立與正式部署上線

### 需求 / 問題描述
使用者要求系統直接部署上網，手機開網址即可使用，不需在電腦啟動任何程式。

### 根本原因
初始建置僅有程式碼，尚未綁定實際 Firebase 專案與部署。

### 修改的檔案與內容摘要
- 以 Firebase CLI（已登入帳號）自動完成：建立專案 `ems-system-su1220`、
  註冊 Web 應用程式、產生設定碼寫入 `.env`（不進版控）、
  建立 Firestore 資料庫（asia-east1 台灣）、部署安全規則與 Hosting。
- `.firebaserc`：佔位字串改為實際專案 ID `ems-system-su1220`。
- 上線網址：**https://ems-system-su1220.web.app**
- GitHub 遠端建立並推送：https://github.com/seansu1220/EMS_System

### 待使用者手動一次性操作（Firebase 無 CLI/API 可自動開通）
1. 開 https://console.firebase.google.com/project/ems-system-su1220/authentication/providers
2. 按「開始使用」→ 啟用「電子郵件/密碼」。
3. （選用）同頁啟用「Google」登入（需選擇支援電子郵件）。

---

## 2026-07-22　初始建置

### 需求 / 問題描述
從零建立「救護科業務管理系統」網頁專案，依 `docs/SPEC.md` 規格實作，
並沿用既有專案 Case_Control 的技術架構與程式模式
（React 19 + TypeScript + Vite 6 + Tailwind CSS 4 + React Router 7 + Firebase Auth/Firestore）。

### 根本原因
初始建置（無既有程式碼）。

### 修改的檔案與內容摘要
- **建置設定**：`package.json`、`vite.config.ts`、`tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json`、
  `index.html`、`.env.example`、`.gitignore`、`啟動業務管理系統.bat`（比照 Case_Control）。
- **Firebase / 部署**：`firebase.json`、`.firebaserc`（專案 ID 留佔位字串 `your-project-id`）、
  `firebase/firestore.rules`（三集合 tasks/categories/users 皆限 `ownerUid == auth.uid`，
  建立時強制、users 限本人文件）、`firebase/firestore.indexes.json`（排序/篩選於用戶端完成，不需複合索引）。
- **型別（型別先行）**：`src/types/user.ts`、`category.ts`、`task.ts`。
- **配置（配置驅動）**：`src/config/constants.ts`
  （集合名稱、優先度/狀態選項含中文標籤與色調、提醒天數 7/30/urgent 3、預設屬性採購/系統/其他）。
- **核心邏輯（職責分離、不 import React）**：
  `src/lib/firebase.ts`（環境變數注入 + 缺漏檢查）、
  `src/lib/taskLogic.ts`（純函式：today/daysUntil/sortTasks/getReminderTasks/isOverdue）、
  `src/services/authService.ts`（Email 密碼 + Google 登入、users 文件建立）、
  `src/services/taskService.ts`（業務 CRUD、進度紀錄、狀態改已完成自動記/清 completedAt）、
  `src/services/categoryService.ts`（屬性 CRUD、預設屬性建立、排序交換、刪除前使用數檢查與批次轉移）。
- **狀態（hooks/context）**：`src/context/authContext.ts`、`AuthProvider.tsx`
  （登入監聽 + 首次登入建立預設屬性）、`src/hooks/useAuth.ts`、`useTasks.ts`、`useCategories.ts`。
- **元件（UI 純顯示）**：`src/components/ui.tsx`、`GoogleSignInButton.tsx`、`ProtectedRoute.tsx`、
  `Layout.tsx`、`ReminderPanel.tsx`（逾期紅/3 天內橙、7↔30 天展開切換、點擊跳轉）、
  `TaskForm.tsx`（新增/編輯共用）、`ProgressSection.tsx`（進度紀錄新增/刪除，新到舊）。
- **頁面**：`src/pages/LoginPage.tsx`、`RegisterPage.tsx`、`HomePage.tsx`
  （提醒卡 + 屬性頁籤 + 顯示已完成開關 + 關鍵字搜尋）、`NewTaskPage.tsx`、
  `TaskDetailPage.tsx`（編輯 + 進度 + 刪除二次確認）、`CategoriesPage.tsx`
  （新增/改名/上下移/刪除，刪除仍被使用的屬性須先選轉移目標批次轉移）。
- **入口**：`src/main.tsx`、`src/App.tsx`（路由）、`src/index.css`、`src/vite-env.d.ts`。

### 與 SPEC 不同的決定
- **新增 `/register` 公開路由與 `RegisterPage`**：SPEC 2.5 路由表僅列 `/login`，
  但 2.1 要求 Email/密碼「註冊」登入，且登入頁需有註冊入口，故補上獨立註冊頁（比照 Case_Control 模式）。

### 驗收
- `npm install`：成功（170 packages）。
- `npm run build`（tsc -b && vite build）：零錯誤通過（僅有 Firebase bundle 體積 > 500kB 的常規警告，非錯誤）。
