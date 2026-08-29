@echo off
cd /d "%~dp0..\.."
title Clear MCI Permissions - Stations Only (DRY RUN)

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
echo   Clear MCI Permissions - STATIONS ONLY (DRY RUN)
echo   ----------------------------------------------
echo   NOTHING WILL BE CHANGED. This run only looks.
echo.
echo   Scope: ONLY units whose name contains the word
echo   for "station". Sections, brigades and centres
echo   are left exactly as they are.
echo   Change it with MCI_CLEAR_UNIT_KEYWORDS in
echo   tools\mci-perm\.env (comma separated).
echo   MCI_KEEP_UNITS is honoured on top of that.
echo.
echo   Step 1: it lists everyone in those stations
echo           (about 10 minutes, read only). It also
echo           prints the units it is NOT touching -
echo           read that list once, in case a station
echo           is not named like one.
echo   Step 2: for each person it opens the settings
echo           page and reports the current state.
echo.
echo   People who do not have the permission are
echo   skipped without pressing anything.
echo.
echo   If NO station is found at all, it stops and
echo   prints the real unit list - nothing is done.
echo.
echo   1. A browser opens - type the CAPTCHA, sign in.
echo   2. Leave it running. You can close the window
echo      any time - it resumes where it stopped.
echo.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo ==================================================
echo.

call npm run tool:mci -- clear-stations %*

echo.
echo Press any key to close this window.
pause >nul
