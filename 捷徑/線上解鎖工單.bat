@echo off
cd /d "%~dp0.."
title Online Unlock Queue (LIVE - WILL MODIFY DATA)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This is the LIVE version: it really presses the unlock button and writes
rem the result back to the web page. The DRY RUN version lives in the
rem "not often used" folder.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org, or use the portable
  echo version built by the "build portable version" shortcut.
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
echo ============================================
echo   Online Unlock Queue - LIVE MODE
echo   ****  THIS REALLY CHANGES THE SYSTEM  ****
echo   ----------------------------------------
echo   Picks up the unlock requests submitted on
echo   the web page and processes all of them.
echo.
echo   1. It first shows how many requests are
echo      waiting. No requests = nothing happens,
echo      the browser does not even open.
echo   2. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo   3. Each result is written back to the web
echo      page as soon as that case is done, so
echo      the people who asked can see it.
echo.
echo   Anything the tool cannot pin down to exactly
echo   one record sheet is SKIPPED, never guessed.
echo   Log: tools\ems-report\out\last-run.log
echo.
echo   First time? Fill in EMS_WEB_EMAIL and
echo   EMS_WEB_PASSWORD in tools\ems-report\.env
echo   (see .env.example next to it).
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

call npm run tool:ems -- unlock-online --execute %*

echo.
echo Press any key to close this window.
pause >nul
