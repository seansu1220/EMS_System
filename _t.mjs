import XLSX from './tools/ems-report/xlsxNode.mjs';
const wb = XLSX.readFile(process.argv[2]);
for (const name of wb.SheetNames) {
  console.log(`\n===== ${name} =====`);
  for (const row of XLSX.utils.sheet_to_json(wb.Sheets[name], { header:1, defval:'', blankrows:false }))
    console.log(row.map(String).join(' | '));
}
