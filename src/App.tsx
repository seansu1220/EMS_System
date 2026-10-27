/** 應用程式路由設定。 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { HomePage } from './pages/HomePage';
import { NewTaskPage } from './pages/NewTaskPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { ChecklistTemplatesPage } from './pages/ChecklistTemplatesPage';
import { ToolsPage } from './pages/ToolsPage';
import { UnlockPage } from './pages/UnlockPage';
import { TriageTagPage } from './pages/TriageTagPage';
import { UsersPage } from './pages/UsersPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/*
        解鎖工單頁、測試用傷票領取頁、小工具自成一區：**「解鎖專用」帳號唯一進得去的地方**。
        其餘所有頁面都屬於業務管理系統，那種帳號一律被導回這裡。
      */}
      <Route
        element={
          <ProtectedRoute requireTaskSystem={false}>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="unlock" element={<UnlockPage />} />
        {/* 測試用傷票領取：同樣三種角色都能用（解鎖專用帳號的第二個入口）。 */}
        <Route path="triage-tags" element={<TriageTagPage />} />
        {/*
          小工具：三種角色都能進，但只看得到 PDF 工具；電腦端工具說明只給管理員（頁面內判斷）。
          PDF 工具檔案只在瀏覽器處理、不碰資料庫。
        */}
        <Route path="tools" element={<ToolsPage />} />
        {/* v1.26 曾有獨立的 /pdf-tools 頁，v1.27 併入小工具；舊網址導向新位置。 */}
        <Route path="pdf-tools" element={<Navigate to="/tools" replace />} />
      </Route>

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="tasks/new" element={<NewTaskPage />} />
        <Route path="tasks/:taskId" element={<TaskDetailPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="templates" element={<ChecklistTemplatesPage />} />
        {/* 假日設定已併入屬性管理（v1.12.2）；舊網址/書籤導向新位置。 */}
        <Route path="holidays" element={<Navigate to="/categories" replace />} />
        {/* 使用者管理：頁面內再檢查管理員身分，非管理員導回首頁。 */}
        <Route path="users" element={<UsersPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
