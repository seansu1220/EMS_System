/**
 * SheetJS 的 Node 專用包裝。
 *
 * SheetJS 的 ESM 版本預設不綁定檔案系統（同一份程式碼也要能在瀏覽器跑），
 * 若不先 `set_fs`，呼叫 `readFile` / `writeFile` 會直接失敗（cannot save file）。
 * 統一從這裡取用 XLSX，避免有人漏掉這個初始化。
 */
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';

XLSX.set_fs(fs);

export default XLSX;
export const { readFile, writeFile, utils } = XLSX;
