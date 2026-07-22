# 變更紀錄（CHANGELOG）

本檔透過 git 同步，供多台電腦查閱歷史紀錄。

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
