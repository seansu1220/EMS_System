@echo off
cd /d "%~dp0..\.."
title MCI Permission - Page Probe

rem NOTE: keep this file pure ASCII (DBCS console breaks on non-ASCII bytes).
rem
rem Records what the pages look like (fields, buttons, dropdown options).
rem Use it when the flow gets stuck, or after the target system changes.
rem It only looks, it never presses a confirm button.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found. Install from https://nodejs.org
  echo.
  pause
  exit /b 1
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
echo   MCI Permission - Page Probe
echo   ----------------------------------------
echo   A browser opens - type the CAPTCHA and
echo   sign in. Then it writes down the structure
echo   of each page (no data is collected).
echo.
echo   Output: tools\mci-perm\out\probe\
echo ============================================
echo.

call npm run tool:mci -- probe %*

echo.
echo Press any key to close this window.
pause >nul
