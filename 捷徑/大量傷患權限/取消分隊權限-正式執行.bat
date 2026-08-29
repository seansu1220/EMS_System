@echo off
cd /d "%~dp0..\.."
title Clear MCI Permissions - Stations Only (EXECUTE)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem THIS REALLY REMOVES PERMISSIONS from every station.
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
echo   Clear MCI Permissions - STATIONS ONLY (EXECUTE)
echo   ----------------------------------------------
echo   THIS REALLY REMOVES PERMISSIONS.
echo   Run the DRY RUN shortcut first.
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
echo   Step 2: it asks you yes/no with the real number.
echo   Step 3: for each person it unchecks "MCI", presses
echo           confirm, then checks again that the
echo           permission is really gone.
echo.
echo   People who do not have the permission are
echo   skipped without pressing anything.
echo.
echo   If NO station is found at all, it stops and
echo   prints the real unit list - nothing is done.
echo.
echo   1. A browser opens - type the CAPTCHA, sign in.
echo   2. Type yes when it asks for confirmation.
echo   3. Leave it running. You can close the window
echo      any time - it resumes where it stopped.
echo.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo ==================================================
echo.

call npm run tool:mci -- clear-stations --execute %*

echo.
echo Press any key to close this window.
pause >nul
