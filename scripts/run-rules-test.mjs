/**
 * `npm run test:rules` 的啟動器：先確保用得到 JDK 21，再跑 Firestore 模擬器與規則測試。
 *
 * 為什麼需要這一層：
 * firebase-tools 15 的模擬器要求 JDK 21 以上，而它是直接呼叫 PATH 上的 `java`
 * （不看 JAVA_HOME）。這台電腦同時裝著舊的 Java 8，且 Oracle 的捷徑目錄在 PATH 中排在前面，
 * 因此即使裝了 JDK 21，`java` 仍會解析到 8 而讓模擬器啟動失敗。
 * 這裡只在「本次執行的環境變數」把 JDK 21 插到 PATH 最前面，
 * 不修改系統設定，也不影響其他需要 Java 8 的程式。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 模擬器要求的最低 Java 主版本。 */
const MIN_JAVA_MAJOR = 21;

/** 常見的 JDK 安裝根目錄（Windows）。 */
const WINDOWS_JDK_ROOTS = [
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Amazon Corretto',
];

/** 讀取某個 java 執行檔的主版本；無法執行或解析失敗回傳 0。 */
function javaMajorVersion(javaPath) {
  const result = spawnSync(javaPath, ['-version'], { encoding: 'utf8' });
  if (result.error || typeof result.stderr !== 'string') return 0;
  // 版本字串可能是 "21.0.11" 或舊式的 "1.8.0_291"。
  const matched = result.stderr.match(/version "(\d+)(?:\.(\d+))?/);
  if (!matched) return 0;
  const major = Number(matched[1]);
  return major === 1 ? Number(matched[2] ?? 0) : major;
}

/** 掃描常見安裝目錄，找出第一個符合版本需求的 JDK bin 目錄；找不到回傳 null。 */
function findJdkBin() {
  const candidates = [];

  // 1) JAVA_HOME（若指向夠新的版本就直接用）。
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin'));

  // 2) 常見安裝根目錄底下的 jdk-* 資料夾。
  if (process.platform === 'win32') {
    for (const root of WINDOWS_JDK_ROOTS) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) {
        if (/jdk[-_]?(\d+)/i.test(entry)) candidates.push(join(root, entry, 'bin'));
      }
    }
  }

  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const bin of candidates) {
    const javaPath = join(bin, `java${suffix}`);
    if (existsSync(javaPath) && javaMajorVersion(javaPath) >= MIN_JAVA_MAJOR) return bin;
  }
  return null;
}

/** 檢查測試用套件是否已安裝（刻意不列入 devDependencies，避免 peer 版本衝突）。 */
function hasRulesTestingPackage() {
  return existsSync(join(process.cwd(), 'node_modules', '@firebase', 'rules-unit-testing'));
}

if (!hasRulesTestingPackage()) {
  console.error(
    '缺少測試套件 @firebase/rules-unit-testing。請先執行：\n' +
      '  npm i --no-save @firebase/rules-unit-testing --legacy-peer-deps',
  );
  process.exit(1);
}

/**
 * 找出環境變數中 PATH 的實際鍵名。
 * Windows 慣用 `Path`，直接寫 env.PATH 會多出一個新鍵而不是覆蓋原本的，
 * 導致子行程拿到殘缺的 PATH（連 npx 都找不到）。
 */
function pathKeyOf(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

const env = { ...process.env };
// PATH 上的 java 已經夠新就不必調整（例如 Linux/macOS，或未安裝舊版 Java 的電腦）。
if (javaMajorVersion('java') < MIN_JAVA_MAJOR) {
  const jdkBin = findJdkBin();
  if (jdkBin === null) {
    console.error(
      `找不到 JDK ${MIN_JAVA_MAJOR} 以上（Firestore 模擬器的必要條件）。請先安裝，例如：\n` +
        '  winget install --id Microsoft.OpenJDK.21',
    );
    process.exit(1);
  }
  console.log(`使用 JDK：${jdkBin}`);
  const pathKey = pathKeyOf(env);
  const separator = process.platform === 'win32' ? ';' : ':';
  env[pathKey] = `${jdkBin}${separator}${env[pathKey]}`;
  env.JAVA_HOME = jdkBin.replace(/[\\/]bin$/, '');
}

// 以單一命令字串交給 shell（若改用 args 陣列 + shell:true，node 會發出 DEP0190 警告）。
const command =
  'npx firebase-tools emulators:exec --only firestore "node scripts/rules.test.mjs"';
const child = spawn(command, { stdio: 'inherit', env, shell: true });
child.on('exit', (code) => process.exit(code ?? 1));
