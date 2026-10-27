/**
 * 小工具頁（/tools）。三種角色都進得來，但看到的內容不同（使用者 2026-10-27 指定）：
 * - 所有人：PDF 工作區（合併、拆分、整理、塗黑／馬賽克／螢光筆都在同一個畫面），檔案只在瀏覽器處理。
 * - 只有管理員：多「電腦端工具說明」（月報表、解鎖救護紀錄表…）與「使用紀錄」（30 天內誰用過 PDF 工具）兩個分區。
 *
 * 純顯示元件。PDF 工具含大型函式庫，以 React.lazy 延遲到真的要顯示時才載入。
 * 網址 #local、#usage 直接開對應分區（非管理員忽略），其他 hash（含舊版的 #merge 等書籤）一律顯示 PDF 工具。
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { LocalToolsGuide } from '../components/LocalToolsGuide';
import { PdfUsageLog } from '../components/PdfUsageLog';
import { CenteredSpinner } from '../components/ui';

const PdfToolbox = lazy(() =>
  import('../components/pdf/PdfToolbox').then((module) => ({ default: module.PdfToolbox })),
);

type ToolsSection = 'pdf' | 'local' | 'usage';

/** 分區定義：pdf 所有人都看得到；其餘只有管理員（adminOnly）。hash 可直接開該區。 */
const SECTIONS: readonly { key: ToolsSection; label: string; hash: string; subtitle: string }[] = [
  { key: 'pdf', label: '📄 PDF 工具', hash: '', subtitle: 'PDF 合併、拆分、整理頁面，以及塗黑、馬賽克、螢光筆。' },
  { key: 'local', label: '💻 電腦端工具說明', hash: '#local', subtitle: '在你自己的電腦上執行的程式，這裡只提供使用說明。' },
  { key: 'usage', label: '📊 使用紀錄', hash: '#usage', subtitle: '近 30 天內有誰用過 PDF 工具。' },
];

/** 網址 hash → 分區；不認得的（含舊版 #merge 書籤）一律是 PDF 工具。 */
const sectionFromHash = (hash: string): ToolsSection => SECTIONS.find((item) => item.hash && item.hash === hash)?.key ?? 'pdf';

export function ToolsPage() {
  const { isAdmin } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [section, setSection] = useState<ToolsSection>(() => sectionFromHash(location.hash));

  useEffect(() => setSection(sectionFromHash(location.hash)), [location.hash]);

  // 非管理員永遠只看到 PDF 工具（直接打 #local、#usage 也一樣）。
  const shown: ToolsSection = isAdmin ? section : 'pdf';
  const [usageOpened, setUsageOpened] = useState(false);
  useEffect(() => {
    if (shown === 'usage') setUsageOpened(true);
  }, [shown]);

  function selectSection(key: ToolsSection) {
    setSection(key);
    navigate({ hash: SECTIONS.find((item) => item.key === key)?.hash ?? '' }, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">小工具</h1>
          <p className="mt-1 text-sm text-slate-500">{SECTIONS.find((item) => item.key === shown)?.subtitle}</p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5" role="tablist" aria-label="小工具分區">
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

      {/* 各區都保持掛載、只切換顯示，切去看說明或紀錄再回來，PDF 工具裡的檔案不會消失。 */}
      <div hidden={shown !== 'pdf'}>
        <Suspense fallback={<CenteredSpinner label="載入 PDF 工具中…" />}>
          <PdfToolbox />
        </Suspense>
      </div>
      {isAdmin && (
        <>
          <div hidden={shown !== 'local'}>
            <LocalToolsGuide />
          </div>
          {/* 使用紀錄第一次打開才開始讀資料庫，之後保持訂閱。 */}
          <div hidden={shown !== 'usage'}>
            <PdfUsageLog active={usageOpened} />
          </div>
        </>
      )}
    </div>
  );
}
