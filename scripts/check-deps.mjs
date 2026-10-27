/**
 * 定期安全更新檢查（npm run deps:check）：列出正式依賴的已知漏洞與可更新的套件。
 * 只讀不改；要更新請看 docs/TODO.md「定期安全更新」的步驟。
 */
import { execSync } from 'node:child_process';

/** 已評估過、確定不影響網頁的漏洞（套件名 → 理由），列出但不算待處理。 */
const ACCEPTED = {
  '@grpc/grpc-js': 'Firestore 在 Node.js 才用得到，不會打包進網頁（2026-10-27 確認）；要升 firebase 大版本才會消失',
  '@firebase/firestore': '同上（依賴 @grpc/grpc-js）',
  '@firebase/firestore-compat': '同上',
  firebase: '同上',
};

/** 處理 PDF、會讀「外來檔案」的套件，出新版要優先跟上。 */
const WATCHED = ['pdfjs-dist', 'pdf-lib', 'jszip', 'jspdf', 'dompurify', 'react-router-dom', 'firebase'];

function runJson(command) {
  try {
    return JSON.parse(execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '{}');
  } catch (error) {
    // npm audit／outdated 有發現時以非 0 結束，但輸出仍是完整 JSON。
    if (error.stdout) return JSON.parse(error.stdout);
    throw new Error(`執行「${command}」失敗（check-deps）：${error.message}`);
  }
}

function reportAudit() {
  const vulnerabilities = runJson('npm audit --omit=dev --json').vulnerabilities ?? {};
  const pending = Object.values(vulnerabilities).filter((item) => !ACCEPTED[item.name]);
  console.log('\n【已知漏洞（正式依賴）】');
  if (pending.length === 0) console.log('  沒有待處理的漏洞。');
  pending.forEach((item) => console.log(`  ✘ ${item.name}（${item.severity}）${item.fixAvailable ? '：可修，跑 npm audit fix' : '：目前沒有修正版'}`));
  Object.entries(ACCEPTED)
    .filter(([name]) => vulnerabilities[name])
    .forEach(([name, reason]) => console.log(`  ・${name}：已評估不影響網頁——${reason}`));
  return pending.length;
}

function reportOutdated() {
  const outdated = runJson('npm outdated --json');
  console.log('\n【可更新的套件】（★＝會讀外來檔案或負責登入，優先更新）');
  const names = Object.keys(outdated).sort((a, b) => Number(WATCHED.includes(b)) - Number(WATCHED.includes(a)));
  if (names.length === 0) console.log('  全部都是最新版。');
  names.forEach((name) => {
    const { current, wanted, latest } = outdated[name];
    console.log(`  ${WATCHED.includes(name) ? '★' : '　'} ${name}：目前 ${current}，相容最新 ${wanted}，最新 ${latest}`);
  });
}

try {
  const pending = reportAudit();
  reportOutdated();
  console.log('\n另外記得：SelfWeb 的 free-tools/vendor/ 是手動複製的檔案，npm 查不到，請對照 TODO 的版本清單。');
  process.exitCode = pending > 0 ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
