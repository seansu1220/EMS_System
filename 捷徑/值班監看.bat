@echo off
cd /d "%~dp0.."
title Duty Watch - Unlock Queue + MCI Permission

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem Watches BOTH systems from one window:
rem   - EMS record system: online unlock requests (handled automatically)
rem   - NFA one-stop portal: MCI permission grants (paste a name list)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org
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
  echo and fill in MCI_ENTRY_URL.
  echo.
  echo Tip: to watch only the unlock queue, run this instead:
  echo   npm run tool:duty -- --execute --only=unlock
  echo.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Duty Watch (LIVE - it really acts)
echo   ----------------------------------------------
echo   TWO browser windows will open. Sign in to each
echo   one: type the CAPTCHA and press login.
echo     1st window: EMS record system
echo     2nd window: NFA one-stop portal
echo.
echo   After that, keep this window open all day:
echo.
echo   * Unlock requests are handled automatically.
echo   * To grant MCI permission, paste the name list
echo     here (one per line: unit,name) and press
echo     Enter on an EMPTY line. RIGHT-CLICK pastes.
echo.
echo   Login is kept alive with a heartbeat. If a
echo   session is dropped, this window beeps and asks
echo   you to sign in again in THAT browser window.
echo   The other system keeps working meanwhile.
echo.
echo   Log: tools\duty-watch\out\duty-watch.log
echo   Press Ctrl+C or close the window to stop.
echo ==================================================
echo.

call npm run tool:duty -- --execute %*

echo.
echo Press any key to close this window.
pause >nul
