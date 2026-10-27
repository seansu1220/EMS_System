/**
 * PDF 工作區的狀態：來源檔（含 pdf.js 預覽文件）＋頁面清單（reducer 在 lib/pdfWorkspace.ts）。
 * 加入檔案時逐一讀取，圖片當場轉成一頁 PDF；清空或離開頁面時關閉所有 pdf.js 文件釋放記憶體。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { PDF_WORKSPACE_CONFIG } from '../config/pdfTools';
import { imageToPdfBytes, loadPdfDocument, readFileBytes } from '../lib/pdfEngine';
import { detectFileKind } from '../lib/pdfPageLogic';
import { closePdfPreview, getPageGeometry, openPdfForPreview } from '../lib/pdfRender';
import { EMPTY_WORKSPACE, workspaceReducer } from '../lib/pdfWorkspace';
import type { ImagePageMode, PageSize, WorkPage, WorkSource } from '../types/pdfTools';

/** 讀一個檔案成為來源檔；不支援或讀不了時丟出中文訊息。 */
async function loadSource(file: File, id: string, colorIndex: number, imageMode: ImagePageMode): Promise<WorkSource> {
  const kind = detectFileKind(file);
  if (!kind) throw new Error(`${file.name}（格式不支援，只收 PDF、JPG、PNG）`);
  const raw = await readFileBytes(file);
  const bytes = kind === 'pdf' ? raw : await imageToPdfBytes(raw, kind, file.name, imageMode);
  const pageCount = (await loadPdfDocument(bytes, file.name)).getPageCount();
  const preview = await openPdfForPreview(bytes, file.name);
  const pageSizes: PageSize[] = [];
  const baseRotations: number[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const geometry = await getPageGeometry(preview, pageNumber);
    pageSizes.push({ width: geometry.width, height: geometry.height });
    baseRotations.push(geometry.rotation);
  }
  return { id, name: file.name, kind, bytes, pageCount, pageSizes, baseRotations, preview, colorIndex };
}

export function usePdfWorkspace() {
  const [state, dispatch] = useReducer(workspaceReducer, EMPTY_WORKSPACE);
  const [sources, setSources] = useState<ReadonlyMap<string, WorkSource>>(new Map());
  const sourcesRef = useRef(sources);
  const counters = useRef({ source: 0, page: 0 });
  sourcesRef.current = sources;

  useEffect(() => () => sourcesRef.current.forEach((source) => closePdfPreview(source.preview)), []);

  /** 依序加入檔案（頁面接在清單最後）；回傳讀不了的檔案與原因。 */
  const addFiles = useCallback(async (files: File[], imageMode: ImagePageMode): Promise<{ addedPages: number; skipped: string[] }> => {
    const skipped: string[] = [];
    const loaded: WorkSource[] = [];
    for (const file of files) {
      const id = `s${++counters.current.source}`;
      try {
        const colorIndex = (counters.current.source - 1) % PDF_WORKSPACE_CONFIG.sourceColors.length;
        loaded.push(await loadSource(file, id, colorIndex, imageMode));
      } catch (error) {
        skipped.push((error as Error).message);
      }
    }
    if (loaded.length === 0) return { addedPages: 0, skipped };
    setSources((current) => new Map([...current, ...loaded.map((source) => [source.id, source] as const)]));
    const pages: WorkPage[] = loaded.flatMap((source) =>
      Array.from({ length: source.pageCount }, (_, index) => ({
        id: `p${++counters.current.page}`,
        sourceId: source.id,
        sourcePageIndex: index,
        rotation: 0,
        marks: [],
      })),
    );
    dispatch({ type: 'addPages', pages });
    return { addedPages: pages.length, skipped };
  }, []);

  /** 清空工作區：關閉所有預覽文件。 */
  const reset = useCallback(() => {
    sourcesRef.current.forEach((source) => closePdfPreview(source.preview));
    setSources(new Map());
    dispatch({ type: 'reset' });
  }, []);

  return { state, dispatch, sources, addFiles, reset };
}
