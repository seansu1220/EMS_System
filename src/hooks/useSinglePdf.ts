/**
 * 拆分、頁面整理共用：開啟「一份」PDF（驗證可處理、取頁數、建立縮圖用的 pdf.js 文件）。
 * 換檔或離開頁面時自動關閉舊的 pdf.js 文件，釋放記憶體與 worker。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPdfDocument, readFileBytes } from '../lib/pdfEngine';
import { closePdfPreview, openPdfForPreview, type PDFDocumentProxy } from '../lib/pdfRender';
import { detectFileKind } from '../lib/pdfPageLogic';

export interface LoadedPdf {
  file: File;
  bytes: Uint8Array;
  pageCount: number;
  preview: PDFDocumentProxy;
}

export function useSinglePdf() {
  const [source, setSource] = useState<LoadedPdf | null>(null);
  const currentRef = useRef<LoadedPdf | null>(null);

  useEffect(
    () => () => {
      if (currentRef.current) closePdfPreview(currentRef.current.preview);
    },
    [],
  );

  /** 從選到的檔案中取第一份 PDF 開啟；失敗時丟出可直接顯示的中文訊息。 */
  const open = useCallback(async (files: File[]): Promise<LoadedPdf> => {
    const file = files.find((candidate) => detectFileKind(candidate) === 'pdf');
    if (!file) throw new Error('請選擇 PDF 檔案');
    const bytes = await readFileBytes(file);
    const pageCount = (await loadPdfDocument(bytes, file.name)).getPageCount();
    const preview = await openPdfForPreview(bytes, file.name);
    const loaded = { file, bytes, pageCount, preview };
    if (currentRef.current) closePdfPreview(currentRef.current.preview);
    currentRef.current = loaded;
    setSource(loaded);
    return loaded;
  }, []);

  return { source, open };
}
