@echo off
cd /d "%~dp0..\.."
title Traffic Critical Cases - Official Form

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org then try again.
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

echo.
echo ==================================================
echo   Traffic Critical Cases (triage level 1 and 2)
echo   ----------------------------------------------
echo   Query: last month, closed cases, critical case,
echo   injured by traffic accident, triage level 1 and
echo   level 2 (two queries, merged into one list).
echo.
echo   A Chrome window opens at the login page. Type
echo   the CAPTCHA and sign in. The rest is automatic
echo   and takes about 3 to 5 minutes.
echo.
echo   Template: this folder, LAI WEN GE SHI .xlsx
echo   Result:   tools\ems-report\out\internal\
echo             (contains names and ID numbers)
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ==================================================
echo.

call npm run tool:ems -- traffic %*

echo.
echo Press any key to close this window.
pause >nul
