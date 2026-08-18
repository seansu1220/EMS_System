@echo off
cd /d "%~dp0.."
title MCI Permission Grant (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This shortcut runs the DRY RUN mode: it walks the whole flow but never
rem presses the final confirm button. Use "MCI permission grant (EXECUTE)"
rem once the dry run looks right.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org, or use the portable
  echo version built by the "build portable version" shortcut.
  echo.
  pause
  exit /b 1
)

rem Install packages on first run, or when a new package was added
if not exist "node_modules\playwright-core\" (
  echo Installing required packages, please wait a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. See messages above.
    pause
    exit /b 1
  )
)

if not exist "tools\mci-perm\.env" (
  echo.
  echo [SETUP NEEDED] tools\mci-perm\.env is missing.
  echo Copy tools\mci-perm\.env.example to tools\mci-perm\.env
  echo and fill in MCI_ENTRY_URL - the login page URL of that system.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   MCI Permission Grant (DRY RUN)
echo   ----------------------------------------
echo   1. Paste the name list. One person per line,
echo      "unit,name". Pasting two columns copied
echo      from Excel is fine. Cannot paste with
echo      Ctrl+V? Just RIGHT-CLICK in this window.
echo   2. Press Enter on an EMPTY line to start.
echo   3. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo.
echo   DRY RUN: it stops right before the final
echo   confirm button. Nothing is changed.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

call npm run tool:mci -- grant %*

echo.
echo Press any key to close this window.
pause >nul
