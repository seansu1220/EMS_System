/**
 * 小工具頁（/tools）。三種角色都進得來，但看到的內容不同（使用者 2026-10-27 指定）：
 * - 所有人：PDF 工作區（合併、拆分、整理、塗黑／馬賽克／螢光筆都在同一個畫面），檔案只在瀏覽器處理。
 * - 只有管理員：多一個「電腦端工具說明」分區（月報表、解鎖救護紀錄表…）。
 *
 * 純顯示元件。PDF 工具含大型函式庫，以 React.lazy 延遲到真的要顯示時才載入。
 * 網址 #local 直接開電腦端工具說明（非管理員忽略），其他 hash（含舊版的 #merge 等書籤）一律顯示 PDF 工具。
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { LocalToolsGuide } from '../components/LocalToolsGuide';
import { CenteredSpinner } from '../components/ui';

const PdfToolbox = lazy(() =>
  import('../components/pdf/PdfToolbox').then((module) => ({ default: module.PdfToolbox })),
);

type ToolsSection = 'pdf' | 'local';
const LOCAL_HASH = '#local';

const SECTIONS: readonly { key: ToolsSection; label: string }[] = [
  { key: 'pdf', label: '📄 PDF 工具' },
  { key: 'local', label: '💻 電腦端工具說明' },
];

export function ToolsPage() {
  const { isAdmin } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [section, setSection] = useState<ToolsSection>(location.hash === LOCAL_HASH ? 'local' : 'pdf');

  // hash 改成別的（例如舊版 #merge 書籤）時切回 PDF 區。
  useEffect(() => {
    if (location.hash === LOCAL_HASH) setSection('local');
    else if (location.hash) setSection('pdf');
  }, [location.hash]);

  const showLocal = isAdmin && section === 'local';

  function selectSection(key: ToolsSection) {
    setSection(key);
    navigate({ hash: key === 'local' ? 'local' : '' }, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">小工具</h1>
          <p className="mt-1 text-sm text-slate-500">
            {showLocal ? '在你自己的電腦上執行的程式，這裡只提供使用說明。' : 'PDF 合併、拆分、整理頁面，以及塗黑、馬賽克、螢光筆。'}
          </p>
        </div>
        {isAdmin && (
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist" aria-label="小工具分區">
            {SECTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={section === key}
                onClick={() => selectSection(key)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  section === key ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 兩區都保持掛載、只切換顯示，切去看說明再回來，PDF 工具裡的檔案不會消失。 */}
      <div hidden={showLocal}>
        <Suspense fallback={<CenteredSpinner label="載入 PDF 工具中…" />}>
          <PdfToolbox />
        </Suspense>
      </div>
      {isAdmin && (
        <div hidden={!showLocal}>
          <LocalToolsGuide />
        </div>
      )}
    </div>
  );
}
