<#
  建立「可攜版」資料夾：把小工具＋Node.js＋套件包成一包，複製到隨身碟就能在
  沒有安裝 Node.js 的電腦（例如公務電腦）直接雙擊執行。

  在**自己這台有網路的電腦**執行一次即可，之後只要把產出的資料夾整個複製走。
  瀏覽器沿用該台電腦已安裝的 Chrome 或 Edge，不隨身攜帶。

  用法：雙擊「捷徑\不常用\建立可攜版.bat」，或
        powershell -ExecutionPolicy Bypass -File scripts\make-portable.ps1
#>
param(
  # 產出位置；預設放在專案資料夾旁的「可攜版」（已在 .gitignore 內）
  [string]$Destination = '',
  # 要打包的 Node.js 主版本（LTS）
  [string]$NodeMajor = '22'
)

$ErrorActionPreference = 'Stop'
# 下載大檔時關掉進度條，否則 Invoke-WebRequest 會慢上好幾倍
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $projectRoot '可攜版'
}
$toolRoot = Join-Path $Destination 'EMS工具'
$nodeDir = Join-Path $toolRoot 'node'

<#
  .SYNOPSIS
    產生一支可攜版專用的啟動捷徑（.bat）。

  .DESCRIPTION
    內容一律維持純 ASCII：主控台是 DBCS 代碼頁（cp950），UTF-8 的中文位元組會被
    當成 Big5 前導位元組把後面的字元連同換行一起吃掉，導致 if 區塊被切碎。
    因此這裡寫完會先斷言沒有非 ASCII 字元，寧可打包失敗也不要交出一支會亂掉的批次檔。
#>
function New-Launcher {
  param(
    [Parameter(Mandatory = $true)][string]$FileName,
    # 視窗標題（顯示在工作列，純 ASCII）
    [Parameter(Mandatory = $true)][string]$Title,
    # 開頭方框內要印的說明，空字串代表空一行（故須明確允許空字串）
    [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Notice,
    # 接在 index.mjs 後面的指令與參數
    [Parameter(Mandatory = $true)][string]$Command
  )

  $noticeBlock = ($Notice | ForEach-Object {
    if ([string]::IsNullOrEmpty($_)) { 'echo.' } else { "echo   $_" }
  }) -join "`r`n"

  $content = @"
@echo off
cd /d "%~dp0"
title $Title

set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.
echo ============================================
$noticeBlock
echo ============================================
echo.

"%NODE_EXE%" index.mjs $Command %*

echo.
echo Press any key to close this window.
pause >nul
"@

  if ($content -cmatch '[^\x00-\x7F]') {
    throw "啟動捷徑 $FileName 含非 ASCII 字元，主控台會解碼錯亂，請改寫說明文字"
  }
  Write-BatchFile -Path (Join-Path $toolRoot $FileName) -Content $content
}

<#
  .SYNOPSIS
    把批次檔以 ASCII ＋ CRLF 寫出。

  .DESCRIPTION
    換行一定要是 CRLF：這支 .ps1 若哪天被存成 LF，here-string 的內容就會跟著變成 LF，
    而 cmd.exe 對只有 LF 的批次檔行為並不可靠（區塊與標籤會解析錯）。
    在寫檔這一步統一正規化，就不必依賴腳本自己是什麼換行。
#>
function Write-BatchFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $normalized = ($Content -replace "`r`n", "`n") -replace "`n", "`r`n"
  [System.IO.File]::WriteAllText($Path, "$normalized`r`n", [System.Text.Encoding]::ASCII)
}

<#
  .SYNOPSIS
    準備可攜版自己的 .env。

  .DESCRIPTION
    **帳密一律留白**，由使用者在目標電腦上自己填——隨身碟遺失時被拿走的只有程式碼。
    只有 Firebase 的專案設定（VITE_FIREBASE_*）會從專案根目錄的 .env 帶過來：
    那不是機密（網頁前端本來就把它公開打包進 JS），但線上解鎖工單少了它連不上雲端。

    已經存在就不覆寫——目標電腦上那份可能已經填好帳密了。
#>
function Initialize-PortableEnv {
  $envPath = Join-Path $toolRoot '.env'
  if (Test-Path $envPath) {
    Write-Host '      .env 已存在，保留不覆寫（裡面可能已經填好帳密）'
    return
  }

  $firebaseKeys = @(
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_APP_ID'
  )
  $values = @{}
  $rootEnv = Join-Path $projectRoot '.env'
  if (Test-Path $rootEnv) {
    foreach ($line in (Get-Content -Path $rootEnv -Encoding UTF8)) {
      $pair = $line -split '=', 2
      if ($pair.Count -eq 2) {
        $key = $pair[0].Trim()
        if ($firebaseKeys -contains $key) { $values[$key] = $pair[1].Trim() }
      }
    }
  }

  $missing = $firebaseKeys | Where-Object { [string]::IsNullOrWhiteSpace($values[$_]) }
  if ($missing.Count -gt 0) {
    Write-Warning ("專案根目錄的 .env 讀不到 {0}。" -f ($missing -join '、'))
    Write-Warning '可攜版的「線上解鎖工單」會因此連不上雲端（手動貼 TEMSIS 的解鎖不受影響）。'
    Write-Warning ' → 到 Firebase 主控台「專案設定 → 你的應用程式」抄設定碼，補進可攜版的 .env。'
  }

  $firebaseLines = ($firebaseKeys | ForEach-Object { '{0}={1}' -f $_, $values[$_] }) -join "`r`n"
  $envText = @"
# 可攜版的設定檔。填完存檔即可，這個檔案不會被打包程式覆寫。
#
# ── 救護系統（emsdt.tyfd.gov.tw）的帳密 ────────────────────────
# 選填。不填就在瀏覽器開起來之後自己打；驗證碼一律要本人輸入。
EMS_USERNAME=
EMS_PASSWORD=

# ── 網頁系統（ems-system-su1220.web.app）的帳密 ────────────────
# 「線上解鎖工單」要靠這組去拿工單、回寫結果，不填就跑不動。
# 這**不是**上面救護系統的那組，也不是你按「Google 登入」用的 Google 密碼。
# 請另開一組專門給程式用的帳號（步驟見 tools/ems-report/.env.example）。
EMS_WEB_EMAIL=
EMS_WEB_PASSWORD=

# ── Firebase 專案設定（打包時自動帶入，不必動）────────────────
# 這幾個值不是機密：網頁前端本來就公開帶著它們。
$firebaseLines

# ── 增減試算表（只有「救護預警統計」用得到，可留白）────────────
EMS_ADJUST_SHEET_URL=
EMS_ADJUST_SHEET_GID=
"@

  # 不能有 BOM：Node 的 loadEnvFile 會把 BOM 併進第一個鍵名。
  [System.IO.File]::WriteAllText($envPath, $envText, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
Write-Host '=== 建立可攜版 ===' -ForegroundColor Cyan
Write-Host "產出位置：$toolRoot"

# --- 1. 複製工具程式（只複製 *.mjs 與 README，因此 out/、.env、.auth/ 都不會被帶出去，
#        個案資料、帳密與登入狀態都留在原本這台電腦）---
Write-Host ''
Write-Host '[1/5] 複製工具程式'
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$sourceDir = Join-Path $projectRoot 'tools\ems-report'
Copy-Item -Path (Join-Path $sourceDir '*.mjs') -Destination $toolRoot -Force
foreach ($doc in @('README.md', '.env.example')) {
  $docPath = Join-Path $sourceDir $doc
  if (Test-Path $docPath) { Copy-Item -Path $docPath -Destination $toolRoot -Force }
}

# 來文格式範本（第 8 章用）。可攜版沒有專案根目錄，`../../捷徑/…` 會指到隨身碟外面去，
# 所以範本要跟著工具走一份（範本只有標題與欄位列，沒有任何個案資料）。
$templateSource = Join-Path $projectRoot '捷徑\二級以上因交通事故救護案件\來文格式.xlsx'
if (Test-Path $templateSource) {
  Copy-Item -Path $templateSource -Destination $toolRoot -Force
  Write-Host '      已附上「來文格式.xlsx」範本（二級以上因交通事故救護案件用）'
} else {
  Write-Warning "找不到來文格式範本：$templateSource"
  Write-Warning '可攜版的「二級以上因交通事故救護案件」會在最後一步（產出檔案）失敗。'
}
Write-Host '      完成（未複製 .env、out/ 與 .auth/，帳密、個案資料與登入狀態不會被帶出去）'

# --- 2. 寫一份只列必要套件的 package.json ---
Write-Host ''
Write-Host '[2/5] 準備套件清單'
$rootPackage = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
# firebase 是「線上解鎖工單」用的（拿工單、回寫結果），少了它 unlock-online／unlock-watch 會直接掛掉。
$needed = @('playwright-core', 'pdfjs-dist', 'exceljs', 'xlsx', 'firebase')
$dependencyLines = foreach ($name in $needed) {
  $version = $rootPackage.devDependencies.$name
  if ($null -eq $version) { $version = $rootPackage.dependencies.$name }
  if ($null -eq $version) { throw "主專案的 package.json 裡找不到套件 $name" }
  '    "{0}": "{1}"' -f $name, $version
}
$packageJson = @"
{
  "name": "ems-tool-portable",
  "private": true,
  "type": "module",
  "dependencies": {
$($dependencyLines -join ",`n")
  }
}
"@
Set-Content -Path (Join-Path $toolRoot 'package.json') -Value $packageJson -Encoding utf8
Write-Host "      $($needed -join '、')"

# --- 3. 下載可攜版 Node.js ---
Write-Host ''
Write-Host '[3/5] 下載 Node.js（約 30MB，第一次比較久）'
if (Test-Path (Join-Path $nodeDir 'node.exe')) {
  Write-Host '      已經有了，略過下載'
} else {
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
  $release = $releases | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1
  if ($null -eq $release) { throw "找不到 Node.js v$NodeMajor 的版本資訊" }
  $zipName = "node-$($release.version)-win-x64"
  $zipUrl = "https://nodejs.org/dist/$($release.version)/$zipName.zip"
  $tempZip = Join-Path $env:TEMP "$zipName.zip"
  $tempDir = Join-Path $env:TEMP "ems-portable-node"

  Write-Host "      版本：$($release.version)"
  Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip
  if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }
  Expand-Archive -Path $tempZip -DestinationPath $tempDir -Force
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  Copy-Item -Path (Join-Path $tempDir "$zipName\*") -Destination $nodeDir -Recurse -Force
  Remove-Item -Recurse -Force $tempDir
  Remove-Item -Force $tempZip
  Write-Host '      完成'
}

# --- 4. 用可攜版 Node 安裝套件（裝進可攜資料夾內，不動到系統）---
Write-Host ''
Write-Host '[4/5] 安裝套件'
$env:PATH = "$nodeDir;$env:PATH"
Push-Location $toolRoot
try {
  & (Join-Path $nodeDir 'npm.cmd') install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install 失敗（結束代碼 $LASTEXITCODE）" }
} finally {
  Pop-Location
}

# --- 5. 產生啟動捷徑與設定檔 ---
Write-Host ''
Write-Host '[5/5] 產生啟動捷徑與設定檔'

New-Launcher -FileName '線上解鎖工單.bat' `
  -Title 'Online Unlock Queue (LIVE)' `
  -Command 'unlock-online --execute' `
  -Notice @(
    'Online Unlock Queue - LIVE MODE',
    '----------------------------------------',
    '****  THIS REALLY CHANGES THE SYSTEM  ****',
    '',
    'Takes every pending request from the web',
    'page, unlocks it, and writes the result',
    'back. If there is nothing pending, no',
    'browser is opened at all.',
    '',
    'A browser opens - type the CAPTCHA and',
    'sign in. The rest is hands free.',
    '',
    'Anything it cannot pin down to exactly one',
    'record sheet is SKIPPED, never guessed.',
    'Log: out\last-run.log'
  )

New-Launcher -FileName '線上解鎖工單-自動監看.bat' `
  -Title 'Unlock Queue Watcher (LIVE - STAYS OPEN)' `
  -Command 'unlock-watch --execute' `
  -Notice @(
    'Unlock Queue Watcher - LIVE MODE',
    '----------------------------------------',
    '****  THIS REALLY CHANGES THE SYSTEM  ****',
    '',
    'Stays open and watches the web page. New',
    'requests are handled within ~20 seconds.',
    '',
    '1. A browser opens - type the CAPTCHA and',
    '   sign in. You only do this ONCE.',
    '2. Leave this window open. The tool keeps',
    '   the sign-in alive by itself.',
    '3. If the server drops the session it stops',
    '   and asks you to sign in again. The',
    '   CAPTCHA is never solved for you.',
    '',
    'To stop: close this window, or Ctrl+C.'
  )

New-Launcher -FileName '線上解鎖工單-監看試跑.bat' `
  -Title 'Unlock Queue Watcher (DRY RUN - STAYS OPEN)' `
  -Command 'unlock-watch' `
  -Notice @(
    'Unlock Queue Watcher - DRY RUN',
    '----------------------------------------',
    'Signs in, keeps the sign-in alive, and',
    'shows what it WOULD do. It never unlocks',
    'anything and never writes to the web page.',
    '',
    'Run this FIRST on a new PC: it proves the',
    'sign-in, the heartbeat and the network all',
    'work, without touching any real data.',
    '',
    'Leave it running to see how long the',
    'sign-in survives on this PC.'
  )

New-Launcher -FileName '解鎖救護紀錄表.bat' `
  -Title 'Unlock Ambulance Records (DRY RUN)' `
  -Command 'unlock' `
  -Notice @(
    'Unlock Ambulance Records (DRY RUN)',
    '----------------------------------------',
    '1. Paste TEMSIS numbers, one per line.',
    '   (right-click in this window = paste)',
    '2. Press Enter on an empty line to start.',
    '3. A browser opens - type the CAPTCHA',
    '   and sign in. The rest is automatic.',
    '',
    'This version ONLY reports which record',
    'would be unlocked. It never clicks it.'
  )

New-Launcher -FileName '正式解鎖救護紀錄表.bat' `
  -Title 'Unlock Ambulance Records (LIVE)' `
  -Command 'unlock --execute' `
  -Notice @(
    'Unlock Ambulance Records - LIVE MODE',
    '----------------------------------------',
    '****  THIS REALLY CHANGES THE SYSTEM  ****',
    '',
    '1. Paste TEMSIS numbers, one per line.',
    '   (right-click in this window = paste)',
    '2. Press Enter on an empty line to start.',
    '3. A browser opens - type the CAPTCHA',
    '   and sign in. The rest is automatic.',
    '',
    'Nothing happens until you paste something,',
    'so opening this by mistake is harmless.',
    'The list of records actually unlocked is',
    'printed at the end.'
  )

New-Launcher -FileName '救護預警統計.bat' `
  -Title 'EMS Report - Prehospital Alert Ratio' `
  -Command 'run' `
  -Notice @(
    'Prehospital Alert Ratio Report',
    '----------------------------------------',
    'A browser opens - type the CAPTCHA and',
    'sign in. KEEP THIS WINDOW OPEN until it',
    'finishes (about 4 minutes).'
  )

New-Launcher -FileName '二級以上因交通事故救護案件.bat' `
  -Title 'Traffic Critical Cases - Official Form' `
  -Command 'traffic' `
  -Notice @(
    'Traffic Cases, Triage Level 1 and 2',
    '----------------------------------------',
    'Last month, closed cases, injured by',
    'traffic accident, in-hospital triage',
    'level 1 and level 2 - filled into the',
    'official form template.',
    '',
    'A browser opens - type the CAPTCHA and',
    'sign in. Takes about half a minute.',
    '',
    'Result: out\internal\ in this folder.',
    'It contains names and ID numbers.'
  )

$settingsLauncher = @'
@echo off
cd /d "%~dp0"
title Portable EMS Tool - Accounts

echo.
echo ============================================
echo   Account settings
echo   ----------------------------------------
echo   Notepad opens the .env file. Fill in the
echo   accounts, save, and close Notepad.
echo   The CAPTCHA is always typed by you.
echo ============================================
echo.

notepad .env
'@
Write-BatchFile -Path (Join-Path $toolRoot '設定登入帳密.bat') -Content $settingsLauncher

Initialize-PortableEnv

$size = (Get-ChildItem -Path $toolRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Host '=== 完成 ===' -ForegroundColor Green
Write-Host ("資料夾：{0}（約 {1:N0} MB）" -f $toolRoot, ($size / 1MB))
Write-Host '把「EMS工具」整個資料夾複製到目標電腦，那台不需要安裝 Node.js。'
Write-Host '第一次先雙擊「設定登入帳密.bat」把帳密填好，之後雙擊要用的那一支即可。'
Write-Host '（該電腦仍需有 Chrome 或 Edge，一般電腦都有。）'
Write-Host ''
