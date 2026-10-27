/**
 * PDF 工具的頁碼運算與檔名處理（純函式，不碰 DOM、不依賴 PDF 函式庫，可獨立測試）。
 */
import { PDF_TOOLS_CONFIG } from '../config/pdfTools';
import type { PageGroupsResult, PdfFileKind, SplitMode } from '../types/pdfTools';

/**
 * 解析頁碼範圍文字，例如 "1-3, 5, 8-" → [[1,2,3],[5],[8,9,10]]。
 * 分隔可用半形／全形逗號、頓號或空白；"8-" 表示第 8 頁到最後，"-3" 表示第 1 到 3 頁。
 */
export function parsePageRanges(text: string, pageCount: number): PageGroupsResult {
  const parts = text.split(/[,，、\s]+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: '請輸入頁碼，例如 1-3, 5' };
  const groups: number[][] = [];
  for (const part of parts) {
    const match = part.match(/^(\d+)?\s*[-~－～]\s*(\d+)?$|^(\d+)$/);
    if (!match) return { ok: false, error: `看不懂「${part}」，格式請用 1-3 或 5` };
    const single = match[3] ? Number(match[3]) : null;
    const start = single ?? (match[1] ? Number(match[1]) : 1);
    const end = single ?? (match[2] ? Number(match[2]) : pageCount);
    if (start < 1 || end > pageCount) {
      return { ok: false, error: `「${part}」超出範圍，這份 PDF 只有 ${pageCount} 頁` };
    }
    if (start > end) return { ok: false, error: `「${part}」起始頁大於結束頁` };
    groups.push(pageSequence(start, end - start + 1));
  }
  return { ok: true, groups };
}

/** 頁碼陣列壓縮成範圍文字，例如 [1,2,3,5] → "1-3, 5"。 */
export function compressRanges(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && page === last[1] + 1) last[1] = page;
    else ranges.push([page, page]);
  }
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/** 每 size 頁分一組。 */
export function chunkPages(pageCount: number, size: number): number[][] {
  const groups: number[][] = [];
  for (let start = 1; start <= pageCount; start += size) {
    groups.push(pageSequence(start, Math.min(size, pageCount - start + 1)));
  }
  return groups;
}

function pageSequence(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

/** 把一個元素移到新位置並回傳新陣列；越界或位置相同時原樣回傳。 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const copy = [...items];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

/** 頁碼組 → 檔名用標籤，例如 [3,4,5] → "第3-5頁"。 */
export function groupLabel(group: readonly number[]): string {
  return group.length === 1 ? `第${group[0]}頁` : `第${group[0]}-${group[group.length - 1]}頁`;
}

/** 依拆分方式算出每個輸出檔的頁碼組（頁碼為目前清單上的第幾頁）。 */
export function buildSplitGroups(
  mode: SplitMode,
  rangeText: string,
  everyN: string,
  pageCount: number,
): PageGroupsResult {
  if (pageCount === 0) return { ok: false, error: '清單上沒有頁面' };
  if (mode === 'single') return { ok: true, groups: chunkPages(pageCount, 1) };
  if (mode === 'every') {
    const size = Number(everyN);
    if (!Number.isInteger(size) || size < 1) {
      return { ok: false, error: '每幾頁一個檔案，請輸入 1 以上的整數' };
    }
    return { ok: true, groups: chunkPages(pageCount, size) };
  }
  if (rangeText.trim() === '') return { ok: false, error: '請輸入頁碼，例如 1-3, 5' };
  return parsePageRanges(rangeText, pageCount);
}

/** 預告將產生的檔案。 */
export function describeSplitGroups(groups: readonly number[][]): string {
  const shown = groups.slice(0, PDF_TOOLS_CONFIG.splitPreviewNameCount);
  const names = shown.map((g) => groupLabel(g).replace('第', '').replace('頁', '')).join('、');
  const more = groups.length > shown.length ? ' …' : '';
  return `將產生 ${groups.length} 個檔案：${names}${more}`;
}

// ---------- 檔名與檔案種類 ----------

export const formatBytes = (n: number) =>
  n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

export const safeFilename = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || '未命名';

/** 依副檔名或 MIME 判斷檔案種類；不支援的回傳 null。 */
export function detectFileKind(file: Pick<File, 'name' | 'type'>): PdfFileKind | null {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return 'pdf';
  if (/\.jpe?g$/i.test(file.name) || file.type === 'image/jpeg') return 'jpg';
  if (/\.png$/i.test(file.name) || file.type === 'image/png') return 'png';
  return null;
}
