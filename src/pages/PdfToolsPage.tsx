/**
 * PDF 工具頁 `/pdf-tools`：合併、拆分、頁面整理三個分頁（移植自 SelfWeb 的 PDF 工具箱）。
 *
 * 檔案全程只在瀏覽器處理，不會上傳、不寫 Firestore，所以三種角色都能用。
 * 三個分頁同時掛載、只切換顯示，切換時各自的檔案與設定不會消失。
 * 網址 #merge／#split／#organize 可直接開啟對應分頁。
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_PDF_TOOL_TAB, PDF_TOOL_TABS, type PdfToolTabKey } from '../config/pdfTools';
import { Card } from '../components/ui';
import { PdfMergePanel } from '../components/pdf/PdfMergePanel';
import { PdfSplitPanel } from '../components/pdf/PdfSplitPanel';
import { PdfOrganizePanel } from '../components/pdf/PdfOrganizePanel';

const PANELS: Record<PdfToolTabKey, () => React.JSX.Element> = {
  merge: PdfMergePanel,
  split: PdfSplitPanel,
  organize: PdfOrganizePanel,
};

const tabFromHash = (hash: string): PdfToolTabKey =>
  PDF_TOOL_TABS.find((tab) => `#${tab.key}` === hash)?.key ?? DEFAULT_PDF_TOOL_TAB;

/** 檔案若拖到拖放區外，瀏覽器預設會直接開啟該檔並離開本頁，在此攔下。 */
function usePreventFileDropNavigation() {
  useEffect(() => {
    const blockFileDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', blockFileDrop);
    window.addEventListener('drop', blockFileDrop);
    return () => {
      window.removeEventListener('dragover', blockFileDrop);
      window.removeEventListener('drop', blockFileDrop);
    };
  }, []);
}

export function PdfToolsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<PdfToolTabKey>(() => tabFromHash(location.hash));
  usePreventFileDropNavigation();

  useEffect(() => setActiveTab(tabFromHash(location.hash)), [location.hash]);

  function selectTab(key: PdfToolTabKey) {
    setActiveTab(key);
    navigate({ hash: key }, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800">PDF 工具</h1>
        <p className="mt-1 text-sm text-slate-500">選擇要做的操作：合併、拆分或整理頁面。</p>
      </div>

      <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="PDF 操作">
        {PDF_TOOL_TABS.map((tab) => {
          const active = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`pdf-panel-${tab.key}`}
              onClick={() => selectTab(tab.key)}
              className={`rounded-xl border px-2 py-3 text-center transition-colors ${
                active ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <div className="text-xl">{tab.icon}</div>
              <div className="text-sm font-bold">{tab.name}</div>
              <div className={`hidden text-xs sm:block ${active ? 'text-slate-300' : 'text-slate-500'}`}>{tab.desc}</div>
            </button>
          );
        })}
      </div>

      <Card>
        {PDF_TOOL_TABS.map(({ key }) => {
          const Panel = PANELS[key];
          return (
            <div key={key} id={`pdf-panel-${key}`} role="tabpanel" hidden={key !== activeTab}>
              <Panel />
            </div>
          );
        })}
      </Card>

      <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        🔒 所有處理都在你的瀏覽器中完成，檔案不會上傳到這個網站或任何伺服器，可安心處理含個資的救護紀錄、公文等文件。
      </p>
    </div>
  );
}
