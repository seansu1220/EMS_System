@echo off
cd /d "%~dp0.."
title EMS Record Unlock (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This shortcut needs Node.js installed on this PC. For a PC where you
rem cannot install anything, run the "build portable version" shortcut first
rem and use the launcher inside the generated folder instead.
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
echo ============================================
echo   Unlock Ambulance Records (DRY RUN)
echo   ----------------------------------------
echo   1. Paste the TEMSIS numbers. Pasting a whole
echo      column at once is fine. Cannot paste with
echo      Ctrl+V? Just RIGHT-CLICK in this window.
echo   2. Press Enter on an EMPTY line to start.
echo   3. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo.
echo   DRY RUN: it only reports which record
echo   would be unlocked, and the date and
echo   vehicle of each case. Nothing is changed.
echo   Log: tools\ems-report\out\last-run.log
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

call npm run tool:ems -- unlock %*

echo.
echo Press any key to close this window.
pause >nul
