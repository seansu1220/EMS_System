/**
 * PDF 工具箱：合併、拆分、頁面整理、編輯四個分頁＋「不用印出來再掃描」小技巧（移植自 SelfWeb 的 PDF 工具箱）。
 * 放在小工具頁 `/tools` 裡，三種角色都看得到。
 *
 * 檔案全程只在瀏覽器處理，不會上傳、不寫 Firestore。
 * 四個分頁同時掛載、只切換顯示，切換時各自的檔案與設定不會消失。
 * 網址 #merge／#split／#organize／#edit 可直接開啟對應分頁。
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_PDF_TOOL_TAB, PDF_CONVERT_TIPS, PDF_TOOL_TABS, type PdfToolTabKey } from '../../config/pdfTools';
import { Card } from '../ui';
import { PdfMergePanel } from './PdfMergePanel';
import { PdfSplitPanel } from './PdfSplitPanel';
import { PdfOrganizePanel } from './PdfOrganizePanel';
import { PdfEditPanel } from './PdfEditPanel';

const PANELS: Record<PdfToolTabKey, () => React.JSX.Element> = {
  merge: PdfMergePanel,
  split: PdfSplitPanel,
  organize: PdfOrganizePanel,
  edit: PdfEditPanel,
};

/** 網址 hash 對應的分頁；不是 PDF 分頁的 hash（例如 #local）回傳 null，維持目前分頁。 */
const tabFromHash = (hash: string): PdfToolTabKey | null =>
  PDF_TOOL_TABS.find((tab) => `#${tab.key}` === hash)?.key ?? null;

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

export function PdfToolbox() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<PdfToolTabKey>(() => tabFromHash(location.hash) ?? DEFAULT_PDF_TOOL_TAB);
  usePreventFileDropNavigation();

  useEffect(() => {
    const fromHash = tabFromHash(location.hash);
    if (fromHash) setActiveTab(fromHash);
  }, [location.hash]);

  function selectTab(key: PdfToolTabKey) {
    setActiveTab(key);
    navigate({ hash: key }, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2" role="tablist" aria-label="PDF 操作">
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
              className={`rounded-xl border px-1 py-3 text-center transition-colors ${
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

      <PdfConvertTips />
    </div>
  );
}

/** 「要變成 PDF 不用印出來再掃描」的各情境做法（內容在 config/pdfTools.ts）。 */
function PdfConvertTips() {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-bold text-slate-800">
        💡 網頁、文件要變成 PDF？不用印出來再掃描
      </summary>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {PDF_CONVERT_TIPS.map((tip) => (
          <div key={tip.title}>
            <h3 className="text-sm font-medium text-slate-700">{tip.title}</h3>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-600">
              {tip.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </details>
  );
}
