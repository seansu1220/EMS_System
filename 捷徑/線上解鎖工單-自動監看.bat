@echo off
cd /d "%~dp0.."
title Unlock Queue Watcher (LIVE - STAYS OPEN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This one STAYS OPEN and processes new requests as they arrive.
rem The one-shot version is "online unlock queue" (no "watch" in the title).
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org.
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
echo   Unlock Queue Watcher - LIVE MODE
echo   ****  THIS REALLY CHANGES THE SYSTEM  ****
echo   ----------------------------------------
echo   Stays open and watches the web page. When
echo   someone submits a request it is processed
echo   within about 20 seconds, hands free.
echo.
echo   1. A browser opens - type the CAPTCHA and
echo      sign in. You only do this ONCE.
echo   2. Leave this window open. The tool touches
echo      the system every few minutes so the
echo      sign-in does not time out.
echo   3. If the server does drop the session, it
echo      stops and asks you to sign in again.
echo      The CAPTCHA is never solved for you.
echo.
echo   Anything the tool cannot pin down to exactly
echo   one record sheet is SKIPPED, never guessed.
echo   Log: tools\ems-report\out\last-run.log
echo.
echo   To stop: close this window, or press Ctrl+C.
echo ============================================
echo.

call npm run tool:ems -- unlock-watch --execute %*

echo.
echo Press any key to close this window.
pause >nul
