/**
 * PDF 工作區的狀態運算（純函式 reducer，不碰 DOM、不依賴 PDF 函式庫，可獨立測試）。
 * 頁面清單的順序就是輸出的順序；每個會改動頁面的動作都先把舊清單（含勾選）存進歷史，才能「復原上一步」。
 */
import { PDF_WORKSPACE_CONFIG } from '../config/pdfTools';
import { normalizeRotation, pageNeedsFlatten } from './pdfEditLogic';
import { baseName, groupLabel, moveItem, safeFilename } from './pdfPageLogic';
import type { PageMark, WorkPage, WorkspaceState } from '../types/pdfTools';

export type WorkspaceAction =
  | { type: 'addPages'; pages: WorkPage[] }
  | { type: 'setCurrent'; pageId: string }
  | { type: 'step'; delta: number }
  | { type: 'toggleSelect'; pageId: string }
  | { type: 'selectAll' }
  | { type: 'clearSelection' }
  | { type: 'move'; from: number; to: number }
  | { type: 'rotate'; delta: number }
  | { type: 'remove' }
  | { type: 'removeSource'; sourceId: string }
  | { type: 'addMark'; pageId: string; mark: PageMark }
  | { type: 'removeMark'; pageId: string; markId: string }
  | { type: 'undo' }
  | { type: 'reset' };

export const EMPTY_WORKSPACE: WorkspaceState = { pages: [], currentPageId: null, selectedIds: [], history: [] };

/** 旋轉、刪除要套用的頁：有勾選就是勾選的頁（依清單順序），沒勾選就是目前看的那頁。 */
export function actionTargetIds(state: WorkspaceState): string[] {
  if (state.selectedIds.length > 0) {
    return state.pages.filter((page) => state.selectedIds.includes(page.id)).map((page) => page.id);
  }
  return state.currentPageId ? [state.currentPageId] : [];
}

/** 換上新的頁面清單：舊清單進歷史，並清掉已不存在的勾選與目前頁。 */
function commitPages(state: WorkspaceState, pages: WorkPage[], preferredCurrent?: string | null): WorkspaceState {
  const snapshot = { pages: state.pages, selectedIds: state.selectedIds };
  const history = [...state.history, snapshot].slice(-PDF_WORKSPACE_CONFIG.historyLimit);
  return { ...state, pages, history, ...fixPointers(state, pages, preferredCurrent) };
}

/** 目前頁不在清單裡時，改指向原位置附近的頁；勾選只留還存在的頁。 */
function fixPointers(
  state: WorkspaceState,
  pages: WorkPage[],
  preferredCurrent?: string | null,
  selectedIds: string[] = state.selectedIds,
) {
  const exists = (id: string | null | undefined) => !!id && pages.some((page) => page.id === id);
  let currentPageId: string | null = exists(preferredCurrent) ? preferredCurrent! : exists(state.currentPageId) ? state.currentPageId : null;
  if (!currentPageId && pages.length > 0) {
    const oldIndex = Math.max(0, state.pages.findIndex((page) => page.id === state.currentPageId));
    currentPageId = pages[Math.min(oldIndex, pages.length - 1)].id;
  }
  return { currentPageId, selectedIds: selectedIds.filter((id) => exists(id)) };
}

function updatePage(pages: WorkPage[], pageId: string, update: (page: WorkPage) => WorkPage): WorkPage[] {
  return pages.map((page) => (page.id === pageId ? update(page) : page));
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'addPages':
      return commitPages(state, [...state.pages, ...action.pages], state.currentPageId ?? action.pages[0]?.id);
    case 'setCurrent':
      return { ...state, currentPageId: action.pageId };
    case 'step': {
      const index = state.pages.findIndex((page) => page.id === state.currentPageId);
      const next = state.pages[index + action.delta];
      return next ? { ...state, currentPageId: next.id } : state;
    }
    case 'toggleSelect': {
      const selected = state.selectedIds.includes(action.pageId);
      return {
        ...state,
        selectedIds: selected ? state.selectedIds.filter((id) => id !== action.pageId) : [...state.selectedIds, action.pageId],
      };
    }
    case 'selectAll':
      return { ...state, selectedIds: state.pages.map((page) => page.id) };
    case 'clearSelection':
      return { ...state, selectedIds: [] };
    case 'move':
      if (action.from === action.to) return state;
      return commitPages(state, moveItem(state.pages, action.from, action.to));
    case 'rotate': {
      const targets = actionTargetIds(state);
      if (targets.length === 0) return state;
      return commitPages(
        state,
        state.pages.map((page) =>
          targets.includes(page.id) ? { ...page, rotation: normalizeRotation(page.rotation + action.delta) } : page,
        ),
      );
    }
    case 'remove': {
      const targets = actionTargetIds(state);
      if (targets.length === 0) return state;
      return commitPages(state, state.pages.filter((page) => !targets.includes(page.id)));
    }
    case 'removeSource':
      return commitPages(state, state.pages.filter((page) => page.sourceId !== action.sourceId));
    case 'addMark':
      return commitPages(state, updatePage(state.pages, action.pageId, (page) => ({ ...page, marks: [...page.marks, action.mark] })));
    case 'removeMark':
      return commitPages(
        state,
        updatePage(state.pages, action.pageId, (page) => ({ ...page, marks: page.marks.filter((mark) => mark.id !== action.markId) })),
      );
    case 'undo': {
      const previous = state.history[state.history.length - 1];
      if (!previous) return state;
      return {
        ...state,
        pages: previous.pages,
        history: state.history.slice(0, -1),
        ...fixPointers(state, previous.pages, null, previous.selectedIds),
      };
    }
    case 'reset':
      return EMPTY_WORKSPACE;
  }
}

/** 統計：有標記的頁數、其中會轉成圖片的頁數。 */
export function summarizePages(pages: readonly WorkPage[]): { markedPages: number; flattenedPages: number } {
  return {
    markedPages: pages.filter((page) => page.marks.length > 0).length,
    flattenedPages: pages.filter((page) => pageNeedsFlatten(page.marks)).length,
  };
}

/** 依來源檔分組（照每個檔第一次出現的順序），給「各檔分開下載」用。 */
export function groupPagesBySource(pages: readonly WorkPage[]): { sourceId: string; pages: WorkPage[] }[] {
  const groups = new Map<string, WorkPage[]>();
  pages.forEach((page) => groups.set(page.sourceId, [...(groups.get(page.sourceId) ?? []), page]));
  return [...groups.entries()].map(([sourceId, grouped]) => ({ sourceId, pages: grouped }));
}

/** 來源檔還有幾頁留在清單上。 */
export function countPagesBySource(pages: readonly WorkPage[]): Map<string, number> {
  const counts = new Map<string, number>();
  pages.forEach((page) => counts.set(page.sourceId, (counts.get(page.sourceId) ?? 0) + 1));
  return counts;
}

// ---------- 下載規劃（決定要產生哪些檔、各含哪些頁、叫什麼名字）----------

export interface ExportPlan {
  groups: { name: string; pages: WorkPage[] }[];
  /** 多個檔案時打包的 ZIP 檔名（不含副檔名）。 */
  zipName: string;
}

/** 全部頁面合成一份。 */
export function planAllPages(pages: readonly WorkPage[], outputName: string): ExportPlan {
  const name = safeFilename(outputName);
  return { groups: [{ name: `${name}.pdf`, pages: [...pages] }], zipName: name };
}

/** 只有勾選的頁（依清單順序）合成一份。 */
export function planSelectedPages(pages: readonly WorkPage[], selectedIds: readonly string[], outputName: string): ExportPlan {
  const name = safeFilename(outputName);
  const selected = pages.filter((page) => selectedIds.includes(page.id));
  return { groups: [{ name: `${name}_勾選${selected.length}頁.pdf`, pages: selected }], zipName: name };
}

/** 每個來源檔各自一份（只含還留在清單上的頁，照清單順序）。 */
export function planPerSource(
  pages: readonly WorkPage[],
  sourceNames: ReadonlyMap<string, string>,
  outputName: string,
): ExportPlan {
  const groups = groupPagesBySource(pages).map(({ sourceId, pages: grouped }) => ({
    name: `${safeFilename(baseName(sourceNames.get(sourceId) ?? '未命名'))}_已處理.pdf`,
    pages: grouped,
  }));
  return { groups, zipName: `${safeFilename(outputName)}_各檔` };
}

/** 依頁碼組（目前清單上的第幾頁，1 起算）拆成多份。 */
export function planSplit(pages: readonly WorkPage[], pageGroups: readonly number[][], outputName: string): ExportPlan {
  const name = safeFilename(outputName);
  const groups = pageGroups.map((group) => ({
    name: `${name}_${groupLabel(group)}.pdf`,
    pages: group.map((pageNumber) => pages[pageNumber - 1]),
  }));
  return { groups, zipName: `${name}_拆分` };
}
