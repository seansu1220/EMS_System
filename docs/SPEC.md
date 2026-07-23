# 救護科業務管理系統 規格書（SPEC）

> 版本：v1.2　建立日期：2026-07-22　最後更新：2026-07-23
> v1.1：移除優先度/狀態欄位、新增待辦清單（checklist）、完成鎖定區塊、表單內快速新增屬性
> v1.2：進度/完成加時間（時:分）、勾待辦可寫入進度、待辦已完成預設隱藏、期限展期按鈕
> 使用者：救護科股長（單一使用者，多裝置使用）

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

### 2.1 登入
- Email/密碼註冊登入 + Google 一鍵登入（同 Case_Control）。
- 所有資料掛 `ownerUid`，僅本人可讀寫（單人使用，但保留安全隔離）。

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

**checklistItems 項目（待辦清單）**：`{ id, content, deadline (yyyy-MM-dd | null), done, createdAt }`
- 主進度之外的小問題 / 支線事項；可新增（內容 + 可選期限）、勾選完成、刪除。
- **勾選完成時跳出確認對話框**「是否將此待辦寫入進度紀錄？」：確定則同一次寫入中
  將該項 done=true 並新增一筆進度（date=今天、time=當下時:分、content=「完成待辦：<內容>」）；
  取消則僅勾選。取消勾選（復原）不跳對話框。
- **已勾掉的項目預設隱藏**，區塊底部提供「顯示已完成（N）」切換按鈕展開/收合。
- 未勾掉且有期限者進首頁提醒卡（標註「待辦」）。
- 排列：未勾在前（依期限近到遠，無期限在後），已勾在後（打勾顯示刪除線）。

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

- 刪除業務需二次確認（未鎖定時才可刪除）。
- 表單儲存成功後按鈕須恢復可按狀態，並短暫顯示「已儲存」提示。

### 2.4 屬性管理 `/categories`
- 預設屬性：採購、系統、其他（首次登入自動建立）。
- 可新增、改名、排序、刪除。
- 排序方式：**拖曳**（桌機滑鼠拖曳、手機長按拖曳，列前有拖曳把手），
  放開後依新順序批次寫入 sortOrder（0..n-1）；不使用上移/下移按鈕。（v1.3 起）
- 刪除前檢查：若仍有業務使用該屬性，須先選擇轉移目標屬性（將該屬性業務批次轉移後再刪除）。

### 2.5 路由
| 路徑 | 頁面 | 權限 |
| --- | --- | --- |
| `/login` | 登入 / 註冊 | 公開 |
| `/` | 首頁（提醒 + 列表） | 需登入 |
| `/tasks/new` | 新增業務 | 需登入 |
| `/tasks/:taskId` | 業務詳情 / 編輯 / 進度 | 需登入 |
| `/categories` | 屬性管理 | 需登入 |

---

## 3. 資料模型（Firestore）

- `users/{uid}`：{ uid, email, displayName, createdAt }
- `categories/{id}`：{ name, sortOrder, ownerUid, createdAt }
- `tasks/{id}`：見 2.3 欄位表

### 安全規則
- 三個集合的讀寫皆要求 `request.auth.uid == resource.data.ownerUid`（users 為本人文件）。
- 建立時強制 `ownerUid == request.auth.uid`。

---

## 4. 目錄結構

```
EMS_System/
├─ src/
│  ├─ types/        task.ts、category.ts、user.ts
│  ├─ config/       constants.ts（提醒天數 7/30、預設屬性、集合名稱）
│  ├─ lib/          firebase.ts
│  ├─ services/     authService、taskService、categoryService
│  ├─ hooks/        useAuth、useTasks、useCategories
│  ├─ context/      authContext、AuthProvider
│  ├─ components/   Layout、ProtectedRoute、ReminderPanel、TaskForm、
│  │                ProgressSection、ui
│  └─ pages/        LoginPage、HomePage、NewTaskPage、TaskDetailPage、
│                   CategoriesPage
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
