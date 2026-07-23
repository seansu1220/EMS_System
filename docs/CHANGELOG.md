# 變更紀錄（CHANGELOG）

本檔透過 git 同步，供多台電腦查閱歷史紀錄。

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
