/**
 * PDF 工作區的狀態運算（純函式 reducer，不碰 DOM、不依賴 PDF 函式庫，可獨立測試）。
 * 頁面清單的順序就是輸出的順序；每個會改動頁面的動作都先把舊清單（含勾選）存進歷史，才能「復原上一步」。
 */
import { PDF_WORKSPACE_CONFIG } from '../config/pdfTools';
import { normalizeRotation, pageNeedsFlatten } from './pdfEditLogic';
import { baseName, groupLabel, safeFilename } from './pdfPageLogic';
import type { PageMark, WorkPage, WorkspaceState } from '../types/pdfTools';
import type { PdfUsageAction, PdfUsageEntry } from '../types/pdfToolUsage';

export type WorkspaceAction =
  | { type: 'addPages'; pages: WorkPage[] }
  | { type: 'setCurrent'; pageId: string }
  | { type: 'step'; delta: number }
  | { type: 'toggleSelect'; pageId: string }
  /** 勾選改成指定的頁（框選用）。 */
  | { type: 'setSelection'; pageIds: string[] }
  /** 勾選兩頁之間（含兩端）的整段（Shift＋點選）；additive＝保留原本的勾選。 */
  | { type: 'selectRange'; fromId: string; toId: string; additive: boolean }
  | { type: 'selectAll' }
  | { type: 'clearSelection' }
  /** 把一批頁搬到 anchor 頁的前面或後面（拖曳排序；一頁或多頁都用這個）。 */
  | { type: 'moveBlock'; pageIds: string[]; anchorId: string; placeAfter: boolean }
  /** 要套用的頁（勾選的頁或目前這頁）整批往前（-1）或往後（+1）一格。 */
  | { type: 'shift'; delta: -1 | 1 }
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

// ---------- 多頁選取與移動（純函式）----------

/** 兩頁之間（含兩端，不論先後）的頁 id，依清單順序；任一頁不存在時回傳空陣列。 */
export function pageIdsBetween(pages: readonly WorkPage[], fromId: string, toId: string): string[] {
  const fromIndex = pages.findIndex((page) => page.id === fromId);
  const toIndex = pages.findIndex((page) => page.id === toId);
  if (fromIndex < 0 || toIndex < 0) return [];
  return pages.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1).map((page) => page.id);
}

/**
 * 把一批頁（保持它們在清單上的先後）搬到 anchor 頁的前面或後面。
 * anchor 本身就在這批裡、或找不到時不動（回傳原陣列）。
 */
export function moveBlock(pages: readonly WorkPage[], movingIds: readonly string[], anchorId: string, placeAfter: boolean): readonly WorkPage[] {
  if (movingIds.includes(anchorId)) return pages;
  const moving = pages.filter((page) => movingIds.includes(page.id));
  const rest = pages.filter((page) => !movingIds.includes(page.id));
  const anchorIndex = rest.findIndex((page) => page.id === anchorId);
  if (moving.length === 0 || anchorIndex < 0) return pages;
  const insertAt = anchorIndex + (placeAfter ? 1 : 0);
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

/**
 * 往前（-1）／往後（+1）一格：每個要移的頁跟前面（後面）緊鄰的、沒有要移的頁交換位置。
 * 連在一起的會整段一起移，已經頂到頭的不動。
 */
export function shiftBlock(pages: readonly WorkPage[], movingIds: readonly string[], delta: -1 | 1): readonly WorkPage[] {
  const result = [...pages];
  const isMoving = (index: number) => movingIds.includes(result[index].id);
  const swap = (a: number, b: number) => ([result[a], result[b]] = [result[b], result[a]]);
  if (delta < 0) {
    for (let index = 1; index < result.length; index++) if (isMoving(index) && !isMoving(index - 1)) swap(index - 1, index);
  } else {
    for (let index = result.length - 2; index >= 0; index--) if (isMoving(index) && !isMoving(index + 1)) swap(index, index + 1);
  }
  return sameOrder(pages, result) ? pages : result;
}

/** 畫面上的矩形（px）。 */
export interface LayoutBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 兩個矩形是否有重疊（框選時判斷框到哪些頁）。 */
export function boxesOverlap(a: LayoutBox, b: LayoutBox): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** 兩個清單的頁順序是否完全相同。 */
export function sameOrder(a: readonly WorkPage[], b: readonly WorkPage[]): boolean {
  return a.length === b.length && a.every((page, index) => page.id === b[index].id);
}

/** 換上新的頁面清單：舊清單進歷史，並清掉已不存在的勾選與目前頁。 */
function commitPages(state: WorkspaceState, pages: readonly WorkPage[], preferredCurrent?: string | null): WorkspaceState {
  const snapshot = { pages: state.pages, selectedIds: state.selectedIds };
  const history = [...state.history, snapshot].slice(-PDF_WORKSPACE_CONFIG.historyLimit);
  return { ...state, pages: [...pages], history, ...fixPointers(state, pages, preferredCurrent) };
}

/** 目前頁不在清單裡時，改指向原位置附近的頁；勾選只留還存在的頁。 */
function fixPointers(
  state: WorkspaceState,
  pages: readonly WorkPage[],
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
    case 'setSelection':
      return { ...state, selectedIds: state.pages.filter((page) => action.pageIds.includes(page.id)).map((page) => page.id) };
    case 'selectRange': {
      const range = pageIdsBetween(state.pages, action.fromId, action.toId);
      const wanted = action.additive ? [...state.selectedIds, ...range] : range;
      return { ...state, selectedIds: state.pages.filter((page) => wanted.includes(page.id)).map((page) => page.id) };
    }
    case 'selectAll':
      return { ...state, selectedIds: state.pages.map((page) => page.id) };
    case 'clearSelection':
      return { ...state, selectedIds: [] };
    case 'moveBlock': {
      const moved = moveBlock(state.pages, action.pageIds, action.anchorId, action.placeAfter);
      return sameOrder(moved, state.pages) ? state : commitPages(state, moved);
    }
    case 'shift': {
      const shifted = shiftBlock(state.pages, actionTargetIds(state), action.delta);
      return shifted === state.pages ? state : commitPages(state, shifted);
    }
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

/** 一次下載要記進使用紀錄的內容（只有數字，不含檔名）。 */
/** 加入檔案時的使用紀錄內容（只有數量，不含檔名）。 */
export function openUsageEntry(addedFiles: number, addedPages: number): PdfUsageEntry {
  return { action: 'open', pageCount: addedPages, fileCount: addedFiles, sourceCount: addedFiles, markedPages: 0 };
}

export function usageEntryFromPlan(action: PdfUsageAction, plan: ExportPlan): PdfUsageEntry {
  const pages = plan.groups.flatMap((group) => group.pages);
  return {
    action,
    pageCount: pages.length,
    fileCount: plan.groups.length,
    sourceCount: new Set(pages.map((page) => page.sourceId)).size,
    markedPages: pages.filter((page) => page.marks.length > 0).length,
  };
}

// ---------- 大圖縮放 ----------

/** 縮放方式：整頁（整頁塞進大圖區塊）、符合寬度，或相對於符合寬度的倍率。 */
export type ViewerZoom = 'page' | 'width' | number;

/** 依縮放方式算出大圖的顯示寬度（px）。aspect＝頁寬÷頁高。 */
export function viewerDisplayWidth(zoom: ViewerZoom, availableWidth: number, availableHeight: number, aspect: number): number {
  const fitWidth = Math.max(0, availableWidth);
  if (zoom === 'width') return fitWidth;
  if (zoom === 'page') return Math.min(fitWidth, Math.max(0, availableHeight) * aspect);
  return fitWidth * zoom;
}

/** 目前相對於「符合寬度」的倍率（給 ＋／－ 與百分比顯示用）。 */
export function zoomFactor(zoom: ViewerZoom, availableWidth: number, availableHeight: number, aspect: number): number {
  if (typeof zoom === 'number') return zoom;
  return availableWidth > 0 ? viewerDisplayWidth(zoom, availableWidth, availableHeight, aspect) / availableWidth : 1;
}

/** ＋／－ 一格：跳到下一個比目前大（或小）的級距；已到盡頭就停在最大（最小）。 */
export function stepZoom(currentFactor: number, direction: 1 | -1, steps: readonly number[]): number {
  const epsilon = 0.001;
  if (direction > 0) return steps.find((step) => step > currentFactor + epsilon) ?? steps[steps.length - 1];
  return [...steps].reverse().find((step) => step < currentFactor - epsilon) ?? steps[0];
}

// ---------- 側邊預覽面板 ----------

/** 預覽面板寬度限制在「最小寬」與「視窗寬－清單最少保留寬」之間；視窗太窄時以最小寬為準。 */
export function clampPanelWidth(
  width: number,
  viewportWidth: number,
  limits: { minWidth: number; minRemainingWidth: number },
): number {
  const maxWidth = Math.max(limits.minWidth, viewportWidth - limits.minRemainingWidth);
  return Math.round(Math.min(Math.max(width, limits.minWidth), maxWidth));
}
