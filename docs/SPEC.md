# 救護科業務管理系統 規格書（SPEC）

> 版本：v1.8　建立日期：2026-07-22　最後更新：2026-07-25
> v1.1：移除優先度/狀態欄位、新增待辦清單（checklist）、完成鎖定區塊、表單內快速新增屬性
> v1.2：進度/完成加時間（時:分）、勾待辦可寫入進度、待辦已完成預設隱藏、期限展期按鈕
> v1.7：業務說明欄位加大、待辦可編輯期限/內容與拖曳排流程順序、完成進度條、待辦公版（範本）
> v1.8：多人共用同一批資料 + 帳號審核制 + 角色權限（僅管理員可刪除業務）
> v1.8.1：屬性與待辦公版的刪除一併限管理員
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
| `/tools` | 小工具（保留區域） | 需登入且已核准 |
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

## 4. 目錄結構

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
├─ scripts/         rules.test.mjs（Firestore 安全規則測試）
├─ firebase/        firestore.rules
├─ docs/            SPEC.md、CHANGELOG.md
├─ firebase.json / .firebaserc
├─ 啟動業務管理系統.bat
└─ package.json、vite/tsconfig、index.html、.env（不進版控）
```

---

## 5. 環境設定與部署

1. Firebase 主控台建立新專案，啟用 Authentication（Email/密碼 + Google）與 Firestore。
2. 複製 `.env.example` 為 `.env`，填入 Firebase 網頁設定碼。
3. `npm install` → `npm run dev`（或雙擊「啟動業務管理系統.bat」）。
4. 部署：`npm run build` → `npx firebase-tools deploy`，取得 `https://<專案ID>.web.app`，手機直接開啟。

---

## 6. 未來可擴充

- 行事曆檢視、到期 Email/LINE 通知、附件上傳、統計報表。
