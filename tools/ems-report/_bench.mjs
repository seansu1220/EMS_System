import XLSX from './xlsxNode.mjs';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';

// 造一份與實際匯出檔同規模的檔案：7699 列 x 243 欄
const ROWS = 7699, COLS = 243;
const squads = ['桃園分隊','中路分隊','大林分隊','三民分隊','大有分隊','八德分隊','龜山分隊','中壢分隊'];
const header = Array.from({length:COLS}, (_,i) => i===4 ? '出勤單位' : `欄位${i}`);
const aoa = [header];
for (let r=0; r<ROWS; r++) {
  const row = new Array(COLS);
  for (let c=0; c<COLS; c++) row[c] = c===4 ? squads[r%squads.length] : (c%3===0 ? r*c : `值${r}-${c}`);
  aoa.push(row);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bench-'));
const file = path.join(dir,'big.xlsx');
console.time('  建立測試檔');
XLSX.writeFile(XLSX.utils.book_new0 ?? (()=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(aoa),'S');return wb;})(), file);
console.timeEnd('  建立測試檔');
console.log('  檔案大小:', (fs.statSync(file).size/1024/1024).toFixed(1), 'MB\n');

const time = (label, fn) => { const s=Date.now(); const r=fn(); console.log(`${label.padEnd(38)} ${((Date.now()-s)/1000).toFixed(2)}s  → ${r}`); };

// A. 目前作法
time('A 現行：readFile + sheet_to_json', () => {
  const wb = XLSX.readFile(file);
  const m = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, defval:'', blankrows:false });
  return `${m.length} 列 x ${m[0].length} 欄`;
});

// B. dense + raw
time('B dense:true + raw:true', () => {
  const wb = XLSX.readFile(file, { dense:true });
  const m = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, defval:'', blankrows:false, raw:true });
  return `${m.length} 列`;
});

// C. 只讀需要的那一欄（先讀標題列找欄位，再限定 range）
time('C 只讀單一欄（限定 range）', () => {
  const wb = XLSX.readFile(file);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const hdr = XLSX.utils.sheet_to_json(sh, { header:1, range:0 })[0];
  const idx = hdr.indexOf('出勤單位');
  const ref = XLSX.utils.decode_range(sh['!ref']);
  const col = XLSX.utils.sheet_to_json(sh, { header:1, raw:true,
    range: { s:{r:1,c:idx}, e:{r:ref.e.r,c:idx} } });
  return `第 ${idx} 欄、${col.length} 筆`;
});
fs.rmSync(dir, { recursive:true, force:true });
