@echo off
cd /d "%~dp0..\.."
title Clear ALL MCI Permissions (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem DRY RUN: it only LOOKS. Nothing is changed.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found. Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "tools\mci-perm\.env" (
  echo.
  echo [SETUP NEEDED] tools\mci-perm\.env not found.
  echo Copy tools\mci-perm\.env.example to tools\mci-perm\.env
  echo and fill in MCI_ENTRY_URL first.
  echo.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Clear ALL MCI Permissions - DRY RUN
echo   ----------------------------------------------
echo   NOTHING WILL BE CHANGED. This run only looks.
echo.
echo   Step 1: it walks every unit in the dropdown and
echo           lists who is in it (about 10 minutes).
echo   Step 2: for each person it opens the settings
echo           page and reports the current state.
echo.
echo   The units kept untouched are set by
echo   MCI_KEEP_UNITS in tools\mci-perm\.env
echo   (default: the emergency medical service section).
echo.
echo   1. A browser opens - type the CAPTCHA, sign in.
echo   2. Leave it running. You can close the window
echo      any time - it resumes where it stopped.
echo.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo ==================================================
echo.

call npm run tool:mci -- clear-all %*

echo.
echo Press any key to close this window.
pause >nul
