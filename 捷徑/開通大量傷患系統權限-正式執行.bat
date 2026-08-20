@echo off
cd /d "%~dp0.."
title MCI Permission Grant (EXECUTE)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This shortcut REALLY grants the permission (presses the confirm button).
rem The tool asks for a yes/no confirmation before it starts.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org, or use the portable
  echo version built by the "build portable version" shortcut.
  echo.
  pause
  exit /b 1
)

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
echo   MCI Permission Grant (EXECUTE)
echo   ----------------------------------------
echo   THIS REALLY CHANGES PERMISSIONS.
echo   Run the DRY RUN shortcut first.
echo.
echo   EASIEST: drag your Excel file onto this
echo   shortcut - it reads the list from the file.
echo   (Columns are found by the header row, so
echo    "name" and "unit" can be in any order.)
echo.
echo   Or paste it here instead:
echo   1. Paste the name list ("unit,name" per line).
echo      RIGHT-CLICK in this window pastes.
echo   2. Press Enter on an EMPTY line.
echo   3. Type yes to confirm.
echo   4. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

if not "%~1"=="" (
  echo Name list file: %~nx1
  echo.
  call npm run tool:mci -- grant --execute --file="%~1"
) else (
  call npm run tool:mci -- grant --execute %*
)

echo.
echo Press any key to close this window.
pause >nul
