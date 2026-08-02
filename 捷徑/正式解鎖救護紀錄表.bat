@echo off
cd /d "%~dp0.."
title EMS Record Unlock (LIVE - WILL MODIFY DATA)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This is the LIVE version: it really presses the unlock button.
rem The DRY RUN version is "unlock ambulance records" (no LIVE in the title).
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
echo   Unlock Ambulance Records - LIVE MODE
echo   ****  THIS REALLY CHANGES THE SYSTEM  ****
echo   ----------------------------------------
echo   Records that match are set back to OPEN
echo   ("adjust to unclosed"). This CANNOT be
echo   undone by this tool.
echo.
echo   1. Paste the TEMSIS numbers. Pasting a whole
echo      column at once is fine. Cannot paste with
echo      Ctrl+V? Just RIGHT-CLICK in this window.
echo   2. Press Enter on an EMPTY line to start.
echo   3. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo.
echo   Anything the tool cannot pin down to exactly
echo   one record sheet is SKIPPED, never guessed.
echo   A list of what was actually unlocked is
echo   printed at the end.
echo   Log: tools\ems-report\out\last-run.log
echo.
echo   Wrong window? Just close it - nothing has
echo   happened until you paste numbers and sign in.
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

call npm run tool:ems -- unlock --execute %*

echo.
echo Press any key to close this window.
pause >nul
