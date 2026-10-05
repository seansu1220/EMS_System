@echo off
cd /d "%~dp0.."
title EMS Open Cases Summary (read only)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem READ ONLY: this never changes anything in the ambulance system.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org then try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\pdfjs-dist\" (
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
echo   Open Cases Summary  (READ ONLY)
echo   ----------------------------------------------
echo   1. Type the start date and the end date,
echo      e.g. 2026-09-01 and 2026-09-30
echo      (ROC dates like 115/09/01 also work).
echo   2. A Chrome window opens at the login page.
echo      Type the CAPTCHA and sign in.
echo   3. The rest is automatic. Each open record
echo      takes about 10-20 seconds.
echo.
echo   Closed this window by mistake? Run it again
echo   within 12 hours with the SAME dates and it
echo   continues where it stopped.
echo.
echo   Result: tools\ems-report\out\internal\
echo   Log:    tools\ems-report\out\last-run.log
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ==================================================
echo.

call npm run tool:ems -- open-cases %*

echo.
echo Press any key to close this window.
pause >nul
