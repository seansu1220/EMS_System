# 救護科業務管理系統 規格書（SPEC）

> 版本：v1.9　建立日期：2026-07-22　最後更新：2026-07-26
> v1.1：移除優先度/狀態欄位、新增待辦清單（checklist）、完成鎖定區塊、表單內快速新增屬性
> v1.2：進度/完成加時間（時:分）、勾待辦可寫入進度、待辦已完成預設隱藏、期限展期按鈕
> v1.7：業務說明欄位加大、待辦可編輯期限/內容與拖曳排流程順序、完成進度條、待辦公版（範本）
> v1.8：多人共用同一批資料 + 帳號審核制 + 角色權限（僅管理員可刪除業務）
> v1.8.1：屬性與待辦公版的刪除一併限管理員
> v1.9：新增本機小工具「救護紀錄表查詢（到院前預警比率統計）」，於電腦端執行、個案明細不上雲（見第 4 章）
> 使用者：救護科股長（管理員）＋經核准的代理同事，多裝置使用

輔助救護科股長辦公的業務與行程管理網頁系統。可新增業務、註記期限、更新處理進度、
備註；首頁提供近期任務提醒與依屬性分類的業務列表。桌機 / 手機皆可使用，資料雲端同步。

---

## 1. 技術架構（沿用 Case_Control 模式）

| 層級 | 技術 |
| --- | --- |
| 前端框架 | React 19 + TypeScript |
| 建置工具 | Vite 6 |
| 樣式 | Tailwind CSS 4（響應式，手機優先） |
| 路由 | React Router 7 |
| 驗證 | Firebase Authentication（Email/密碼、Google） |
| 資料庫 | Cloud Firestore（即時同步） |
| 部署 | Firebase Hosting |

### 架構原則
- 職責分離：UI（components/pages）↔ 業務邏輯（services）↔ 狀態（hooks/context），services 不依賴 React。
- 型別先行：跨模組資料結構定義於 `src/types`。
- 配置驅動：狀態選項、優先度、提醒天數等常數集中於 `src/config`。
- 安全在資料庫層：Firestore Security Rules 限制只能存取自己的資料。

---

## 2. 功能規格

### 2.1 登入與帳號審核（v1.8 起）
- Email/密碼註冊登入 + Google 一鍵登入。
- **帳號審核制**：新註冊的帳號狀態為 `pending`（待審核），登入後只看得到「等待管理員核准」畫面，
  **完全無法讀取任何業務資料**（安全規則層阻擋）。管理員核准後畫面**自動解鎖**（即時訂閱 users 文件），
  不需重新登入。管理員可將帳號改為 `rejected`（拒絕/停用），該帳號即無法再進入系統（資料不刪除）。
- 註冊頁明示「新帳號需經管理員核准後才能使用」。
- **管理員以 email 白名單認定**（`ADMIN_EMAILS`，目前為 `seansu1220@gmail.com`），
  不是靠資料庫欄位，避免有人竄改自己的文件提權；該 email 註冊/登入時自動為 `admin` + `approved`。

### 2.1.1 權限模型（v1.8 起）
**資料範圍：全體已核准使用者共用同一批業務 / 屬性 / 待辦公版**（代理職務時可互相接手）。
`ownerUid` 欄位語意自 v1.8 起改為「**建立者**」，不再用於資料隔離。

| 動作 | 管理員 | 一般使用者（已核准） | 待審核 / 未通過 |
| --- | --- | --- | --- |
| 讀取業務、屬性、待辦公版 | ✅ | ✅ | ❌ |
| 新增 / 編輯業務（含進度、待辦、完成/解除） | ✅ | ✅ | ❌ |
| 新增 / 改名 / 排序屬性、新增與編輯待辦公版 | ✅ | ✅ | ❌ |
| **刪除業務** | ✅ | ❌ | ❌ |
| **刪除屬性**（v1.8.1 起） | ✅ | ❌ | ❌ |
| **刪除待辦公版**（v1.8.1 起） | ✅ | ❌ | ❌ |
| 使用者管理（核准 / 停用帳號） | ✅ | ❌ | ❌ |

- 一般使用者的三個「刪除」按鈕（業務 / 屬性 / 公版）皆**不顯示**，即使繞過前端也會被 Firestore 規則擋下。
- 公版內「單一項目」的增刪改屬於編輯（update），一般使用者仍可操作；受限的是刪除整份公版。
- 前端判斷集中於 `src/lib/permissions.ts`（純函式），最終防線為 `firebase/firestore.rules`，兩者須一致。

### 2.2 首頁 `/`
**上方：近期任務提醒卡**
- 預設顯示「已逾期 + 7 天內到期」的項目，依期限由近到遠排序；點擊「展開」改顯示 30 天內。
- 提醒來源兩種：①未完成業務的期限；②未勾掉的待辦事項（checklist）的期限，
  顯示時標註「待辦」並帶出所屬業務名稱。
- 顏色標示：已逾期＝紅色、3 天內＝橙色、其餘＝一般色；每筆顯示期限日期、剩餘/逾期天數、
  名稱、屬性標籤，點擊跳轉業務詳情。
- **無期限且未完成的業務**：不受 7/30 天視窗限制，**永遠顯示**於提醒卡內，
  獨立區段排在有期限項目之後，灰色「未定期限」標籤區隔（避免被遺忘）。（v1.4 起）
- 已完成業務、已勾掉的待辦、無期限的待辦事項不進提醒。

**下方：業務列表**
- 屬性頁籤：「全部」+ 各屬性（依 sortOrder 排序），點選切換篩選。
- 「顯示已完成」開關（預設隱藏已完成）。
- 關鍵字搜尋（業務名稱 / 說明 / 備註）。
- 每筆顯示：業務名稱、屬性、期限（含逾期標紅）、未完成待辦數、最新一筆進度摘要；
  已完成業務顯示「已完成」徽章。
- 排序：未完成在前；未完成之中**無期限的排最上面**（易被遺忘，優先曝光），
  其後依期限近到遠，再依 updatedAt。（v1.4 起；v1.3 前為無期限排最後）
- 「新增業務」按鈕。

### 2.3 業務管理（CRUD）
| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| title | string | 業務名稱（必填） |
| categoryId | string | 屬性（下拉選擇，必填；選單內含「＋新增屬性」可即時建立並選取） |
| description | string | 業務說明 |
| deadline | string \| null | 期限（yyyy-MM-dd，可空＝無期限） |
| progressEntries | array | 進度紀錄（見下） |
| checklistItems | array | 待辦事項清單（見下） |
| note | string | 備註 |
| completed | boolean | 是否完成（完成後鎖定） |
| completionDate | string \| null | 完成日期（yyyy-MM-dd） |
| completionTime | string \| null | 完成時間（HH:mm，可空） |
| completionNote | string | 完成說明 |
| ownerUid | string | 擁有者 |
| createdAt / updatedAt | timestamp | 系統時間 |
| completedAt | timestamp \| null | 標記完成時間 |

（v1.1 起不再有優先度 priority 與狀態 status 欄位；業務只分「進行中 / 已完成」。）

**progressEntries 項目**：`{ id, date (yyyy-MM-dd, 日期選擇器), time (HH:mm | null, 時間選擇器可空), content, createdAt }`
- 由新到舊顯示（日期新→舊，同日依時間新→舊，無時間排該日最後），可新增 / 刪除單筆。

**checklistItems 項目（待辦清單）**：`{ id, content, deadline (yyyy-MM-dd | null), done, sortOrder, createdAt }`
- 主進度之外的小問題 / 支線事項，亦用於拆解**標案等多流程業務**的每個關卡。
- 可新增（內容 + 可選期限）、**編輯（內容與期限，v1.7 起）**、勾選完成、刪除。
  期限可先留空（一開始不知道期限），之後按「編輯」補上或清除。
- **勾選完成時跳出確認對話框**「是否將此待辦寫入進度紀錄？」：確定則同一次寫入中
  將該項 done=true 並新增一筆進度（date=今天、time=當下時:分、content=「完成待辦：<內容>」）；
  取消則僅勾選。取消勾選（復原）不跳對話框。
- **已勾掉的項目預設隱藏**，區塊底部提供「顯示已完成（N）」切換按鈕展開/收合。
- 未勾掉且有期限者進首頁提醒卡（標註「待辦」）。
- **排序模式（v1.7 起）**可切換：
  - 「流程順序」（預設）：依 sortOrder，已勾項目留在原位；未鎖定時可**拖曳左側把手**調整
    （桌機滑鼠、手機長按 200ms），放開後批次寫入 sortOrder（0..n-1）。
  - 「依期限」：未勾在前（期限近到遠，無期限在後），已勾在後（顯示刪除線）。
- **完成進度條（v1.7 起）**：區塊上方顯示「已完成 N / 總數（百分比）」與進度條。
- 逾期未勾以紅色、3 天內以橙色標示期限；無期限者顯示灰色「未定期限」。

**期限展期（業務詳情頁編輯表單，期限欄旁）**
- 已有期限且未鎖定時顯示「展期」按鈕；點擊展開天數選擇（快選 +1 / +3 / +7 天與自訂天數）。
- 確認後期限 = 目前期限 + N 天，並**立即儲存整張表單**（含其他未儲存的欄位修改），不需再按儲存變更。
- 無期限的業務不顯示展期按鈕（先在期限欄選日期即可）。

**完成區塊（業務詳情頁獨立區塊）**
- 填完成日期（預設今天）＋ 完成時間（HH:mm，預設當下，可空）＋ 完成說明，
  按「標記完成」並二次確認 → `completed = true`、記錄 completedAt，
  業務**鎖定**：所有欄位、進度、待辦皆不可修改。
- 已完成業務顯示完成資訊（日期 時間 說明）與「解除完成」按鈕；解除（二次確認）後恢復可編輯，
  completed 改 false、completedAt 清空（completionDate / completionTime / completionNote 保留供參考）。

- 刪除業務需二次確認（未鎖定時才可刪除）；**刪除按鈕僅管理員可見**（v1.8 起，見 2.1.1）。
- 表單儲存成功後按鈕須恢復可按狀態，並短暫顯示「已儲存」提示。

### 2.4 屬性管理 `/categories`
- 預設屬性：採購、系統、其他（系統首次使用時自動建立；屬性為全體共用，只建立一次）。
- 可新增、改名、排序（所有已核准使用者）；**刪除僅管理員**（v1.8.1 起，按鈕對一般使用者不顯示）。
- 排序方式：**拖曳**（桌機滑鼠拖曳、手機長按拖曳，列前有拖曳把手），
  放開後依新順序批次寫入 sortOrder（0..n-1）；不使用上移/下移按鈕。（v1.3 起）
- 刪除前檢查：若仍有業務使用該屬性，須先選擇轉移目標屬性（將該屬性業務批次轉移後再刪除）。

### 2.5 待辦公版 `/templates`（v1.7 起）

把常做的一套流程（例如標案的各關卡）存成公版，重複套用到新業務，不必每次重打。

- **資料**：`checklistTemplates/{id}` = `{ name, items: [{ id, content, sortOrder }], ownerUid, createdAt, updatedAt }`。
  公版**只保存項目內容與順序，不含期限與勾選狀態**（期限於套用後個別編輯）。
- **管理頁**：新增公版（名稱）、改名；公版底下項目可新增、改內容、刪除、拖曳排序。
  **刪除整份公版僅管理員**（v1.8.1 起，按鈕對一般使用者不顯示）。
- **建立公版的兩種方式**：①管理頁新增空白公版後逐筆加項目；
  ②業務詳情頁待辦區塊「另存為公版」，把目前待辦內容（依流程順序）存成新公版。
- **套用公版**：
  - 新增業務頁：選一個公版，建立業務時自動帶入為初始待辦（期限留空）。
  - 業務詳情頁待辦區塊：選公版按「套用公版」，**附加**到現有待辦之後（不覆蓋既有項目），二次確認。
- 刪除公版不影響已套用到業務上的待辦事項。

### 2.6 使用者管理 `/users`（v1.8 起，僅管理員）
- 列出所有註冊帳號（**待審核排最前**，其次已核准、未通過；同組內依註冊時間新到舊）。
- 每列顯示：顯示名稱、email、角色、狀態徽章（待審核＝橙、已核准＝綠、未通過＝紅）。
- 動作（皆二次確認）：`核准`（→ approved）、`拒絕 / 停用`（→ rejected）。
- 管理員自己的帳號與其他白名單 email 不可在此調整（權限來自 email 白名單）。
- 頁首顯示待審核數量提醒；非管理員進入此路徑一律導回首頁。

### 2.7 路由
| 路徑 | 頁面 | 權限 |
| --- | --- | --- |
| `/login` | 登入 / 註冊 | 公開 |
| `/` | 首頁（提醒 + 列表） | 需登入且**已核准** |
| `/tasks/new` | 新增業務（可選待辦公版） | 需登入且已核准 |
| `/tasks/:taskId` | 業務詳情 / 編輯 / 進度 / 待辦 | 需登入且已核准（刪除僅管理員） |
| `/categories` | 屬性管理 | 需登入且已核准 |
| `/templates` | 待辦公版管理 | 需登入且已核准 |
| `/tools` | 小工具（說明頁；工具本身在本機執行，見第 4 章） | 需登入且已核准 |
| `/users` | 使用者管理 | 僅管理員 |

未核准的登入者不論進入哪個受保護路徑，一律顯示「等待管理員核准」畫面。

---

## 3. 資料模型（Firestore）

- `users/{uid}`：{ uid, email, displayName, **role**（admin/member）, **status**（pending/approved/rejected）,
  **reviewedAt**, **reviewedBy**, createdAt }（粗體為 v1.8 新增）
- `categories/{id}`：{ name, sortOrder, ownerUid（建立者）, createdAt }
- `tasks/{id}`：見 2.3 欄位表（ownerUid 為建立者）
- `checklistTemplates/{id}`：見 2.5（待辦公版）

### 安全規則（v1.8 改版）
- 管理員以 `request.auth.token.email` 比對白名單認定（**不讀資料庫欄位**，避免竄改文件提權）；
  白名單須與 `src/config/constants.ts` 的 `ADMIN_EMAILS` 手動保持一致。
- `tasks` / `categories` / `checklistTemplates`：
  讀取與更新須為「已核准使用者」；建立另強制 `ownerUid == request.auth.uid`（記錄建立者）；
  **三者的 delete 皆僅管理員**（v1.8.1 起）。
- `users`：本人可讀自己的文件、可改自己的一般欄位，但 **role 與 status 不可自行變更**（不可自我核准/提權）；
  列出全部帳號與變更他人狀態僅限管理員；建立時強制
  `role/status == (管理員 email ? admin/approved : member/pending)`。
- 規則測試腳本置於 `scripts/rules.test.mjs`（需 JDK 21 + `@firebase/rules-unit-testing`，見檔頭說明）。

---

## 4. 本機小工具：救護紀錄表查詢（v1.9 起）

> 位置 `tools/ems-report/`，是**獨立於網頁系統的本機 CLI**，不參與 `npm run build`、不部署上線。
> 網頁的 `/tools` 頁只放說明，不呈現也不儲存任何查詢結果。

### 4.1 目的
自「桃園市政府消防局緊急救護管理系統」（`https://emsdt.tyfd.gov.tw/EmmWeb/`）取得指定月份的救護紀錄，
統計**各分隊的「到院前預警案件數 ÷ 總案件數」比率**。

### 4.2 個資保護規範（本工具的最高原則）
系統匯出的 Excel 含個案明細，屬個人資料。設計上以「個資不外流」為前提：

| 規範 | 作法 |
| --- | --- |
| 不上雲 | 全程本機執行；不寫入 Firestore、不呼叫任何外部 API、不上傳檔案 |
| 原始明細用完即刪 | 匯出檔只落在 `tools/ems-report/out/raw/`，統計後自動刪除（`--keep-raw` 才保留） |
| 產出只有統計數字 | 最終報表僅含分隊、案件數、預警數、比率，無任何個人欄位 |
| 不進版控 | `.gitignore` 已排除 `tools/**/out/` |
| log 不印明細 | 終端機只顯示流程與筆數 |
| 探測模式不取資料 | `probe` 只記錄欄位／按鈕／下拉選項名稱，不記錄表格資料列，不截圖 |
| 驗證碼不自動破解 | 由使用者本人辨識輸入，不繞過系統的防自動化機制 |
| 帳密不硬寫 | 僅從 `tools/ems-report/.env` 讀取（已 gitignore），且禁用 `VITE_` 前綴以免被打包進前端 |

### 4.3 執行方式
**一般使用一律雙擊捷徑，不需輸入指令**：

| 捷徑（專案根目錄） | 用途 |
| --- | --- |
| `救護預警統計.bat` | 產生上個月的各分隊比較表（日常使用就是這個） |
| `救護預警統計-設定用.bat` | 頁面結構探測，系統改版或初次設定時才用 |

兩支 .bat 都會先確認 Node.js 是否存在（沒有就顯示官網下載連結），
並在缺少套件時自動 `npm install`。批次檔內容維持純 ASCII 訊息，避免主控台中文亂碼。

指令列等價寫法：

| 指令 | 用途 |
| --- | --- |
| `npm run tool:ems -- probe` | 互動式探測頁面結構（開發／系統改版時用） |
| `npm run tool:ems -- run` | 完整流程，預設查「上個月 1 號 ~ 最後一天」 |
| `npm run tool:ems -- run --month=2026-06` | 指定月份 |
| `npm run tool:ems -- run --keep-raw` | 保留原始匯出檔（含個資） |
| `npm run tool:ems:test` | 期間計算的單元測試 |

以本機已安裝的 Chrome 執行（`playwright-core` + `channel: 'chrome'`），不另外下載瀏覽器。

### 4.4 自動化流程
1. 開啟登入頁；帳密可自 `.env` 代填，**驗證碼由使用者在瀏覽器輸入**，程式輪詢等待登入完成。
2. 左側選單 → 報表系統 → 救護紀錄表查詢。
3. 查詢期間設為指定月份 1 號 ~ 最後一天。
4. 急救處置進階搜尋 → 救護狀態＝「已結案」→ 查詢 → 匯出 Excel（**總案件數**）。
5. 同上再加院前預警＝「到院前傳送預警」→ 查詢 → 匯出 Excel（**預警案件數**）。
6. 本機解析兩份 Excel，依分隊彙總，輸出比較表後刪除原始檔。

彈出式視窗封鎖不需另外處理：自動化瀏覽器預設允許彈出視窗與檔案下載。

### 4.5 模組職責
| 檔案 | 職責 |
| --- | --- |
| `config.mjs` | 網址、選擇器、查詢條件文字、輸出路徑（配置驅動） |
| `dateRange.mjs` | 查詢期間計算（純函式，含單元測試） |
| `session.mjs` | 開瀏覽器、代填帳密、等待登入完成 |
| `probe.mjs` | 頁面結構探測（只取結構不取資料） |
| `logger.mjs` | 終端機輸出與帳號遮蔽 |
| `index.mjs` | CLI 進入點 |

### 4.6 實作進度
- ✅ 第一階段：登入流程、探測模式、期間計算、個資防護規範
- ⏳ 第二階段：報表查詢與 Excel 匯出（需先以 `probe` 取得報表系統實際頁面結構）
- ⏳ 第三階段：分隊彙總統計與比較表輸出

---

## 5. 目錄結構

```
EMS_System/
├─ src/
│  ├─ types/        task.ts、category.ts、checklistTemplate.ts、user.ts
│  ├─ config/       constants.ts（提醒天數 7/30、預設屬性、集合名稱、ADMIN_EMAILS）
│  ├─ lib/          firebase.ts、taskLogic.ts、recurrence.ts、checklistLogic.ts、permissions.ts
│  ├─ services/     authService、taskService、categoryService、checklistTemplateService、userService
│  ├─ hooks/        useAuth、useTasks、useCategories、useChecklistTemplates
│  ├─ context/      authContext、AuthProvider
│  ├─ components/   Layout、ProtectedRoute、ReminderPanel、TaskForm、
│  │                ProgressSection、ChecklistSection、ChecklistTemplateBar、
│  │                CompletionSection、ui
│  └─ pages/        LoginPage、RegisterPage、PendingApprovalPage、HomePage、NewTaskPage、
│                   TaskDetailPage、CategoriesPage、ChecklistTemplatesPage、ToolsPage、UsersPage
├─ tools/
│  └─ ems-report/   本機小工具（見第 4 章）：config、dateRange、session、probe、logger、index
│                   out/ 為產出目錄，含個案明細，已 gitignore
├─ scripts/         rules.test.mjs（Firestore 安全規則測試）
├─ firebase/        firestore.rules
├─ docs/            SPEC.md、CHANGELOG.md
├─ firebase.json / .firebaserc
├─ 啟動業務管理系統.bat
├─ 救護預警統計.bat / 救護預警統計-設定用.bat（本機小工具捷徑）
└─ package.json、vite/tsconfig、index.html、.env（不進版控）
```

---

## 6. 環境設定與部署

1. Firebase 主控台建立新專案，啟用 Authentication（Email/密碼 + Google）與 Firestore。
2. 複製 `.env.example` 為 `.env`，填入 Firebase 網頁設定碼。
3. `npm install` → `npm run dev`（或雙擊「啟動業務管理系統.bat」）。
4. 部署：`npm run build` → `npx firebase-tools deploy`，取得 `https://<專案ID>.web.app`，手機直接開啟。

---

## 7. 未來可擴充

- 行事曆檢視、到期 Email/LINE 通知、附件上傳、統計報表。
