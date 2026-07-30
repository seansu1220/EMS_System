<#
  建立「可攜版」資料夾：把小工具＋Node.js＋套件包成一包，複製到隨身碟就能在
  沒有安裝 Node.js 的電腦（例如公家電腦）直接雙擊執行。

  在**自己這台有網路的電腦**執行一次即可，之後只要把產出的資料夾整個複製走。
  瀏覽器沿用該台電腦已安裝的 Chrome 或 Edge，不隨身攜帶。

  用法：雙擊「捷徑\建立可攜版.bat」，或
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

Write-Host ''
Write-Host '=== 建立可攜版 ===' -ForegroundColor Cyan
Write-Host "產出位置：$toolRoot"

# --- 1. 複製工具程式（不含 out/ 與 .env，避免把個案資料或帳密帶出去）---
Write-Host ''
Write-Host '[1/4] 複製工具程式'
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$sourceDir = Join-Path $projectRoot 'tools\ems-report'
Copy-Item -Path (Join-Path $sourceDir '*.mjs') -Destination $toolRoot -Force
$readme = Join-Path $sourceDir 'README.md'
if (Test-Path $readme) { Copy-Item -Path $readme -Destination $toolRoot -Force }
Write-Host '      完成（未複製 .env 與 out/，帳密與個案資料不會被帶出去）'

# --- 2. 寫一份只列必要套件的 package.json ---
Write-Host ''
Write-Host '[2/4] 準備套件清單'
$rootPackage = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$needed = @('playwright-core', 'pdfjs-dist', 'exceljs', 'xlsx')
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
Write-Host '[3/4] 下載 Node.js（約 30MB，第一次比較久）'
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
Write-Host '[4/4] 安裝套件'
$env:PATH = "$nodeDir;$env:PATH"
Push-Location $toolRoot
try {
  & (Join-Path $nodeDir 'npm.cmd') install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install 失敗（結束代碼 $LASTEXITCODE）" }
} finally {
  Pop-Location
}

# --- 5. 產生可攜版自己的啟動捷徑（內容維持純 ASCII，避免主控台中文亂碼）---
$launcher = @'
@echo off
cd /d "%~dp0"
title EMS Record Unlock (Portable)

set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.
echo ============================================
echo   Unlock Ambulance Records (DRY RUN)
echo   ----------------------------------------
echo   1. Paste TEMSIS numbers, one per line.
echo   2. Press Enter on an empty line to start.
echo   3. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo.
echo   This version ONLY reports which record
echo   would be unlocked. It never clicks it.
echo ============================================
echo.

"%NODE_EXE%" index.mjs unlock %*

echo.
echo Press any key to close this window.
pause >nul
'@
Set-Content -Path (Join-Path $toolRoot '解鎖救護紀錄表.bat') -Value $launcher -Encoding ascii

$statsLauncher = @'
@echo off
cd /d "%~dp0"
title EMS Report - Prehospital Alert Ratio (Portable)

set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.
echo   A browser will open. Type the CAPTCHA and sign in.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo.

"%NODE_EXE%" index.mjs run %*

echo.
echo Press any key to close this window.
pause >nul
'@
Set-Content -Path (Join-Path $toolRoot '救護預警統計.bat') -Value $statsLauncher -Encoding ascii

$size = (Get-ChildItem -Path $toolRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Host '=== 完成 ===' -ForegroundColor Green
Write-Host ("資料夾：{0}（約 {1:N0} MB）" -f $toolRoot, ($size / 1MB))
Write-Host '把「EMS工具」整個資料夾複製到隨身碟，在別台電腦雙擊裡面的'
Write-Host '「解鎖救護紀錄表.bat」即可，那台電腦不需要安裝 Node.js。'
Write-Host '（該電腦仍需有 Chrome 或 Edge，一般電腦都有。）'
Write-Host ''
