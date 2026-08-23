@echo off
cd /d "%~dp0..\.."
title Clear ALL MCI Permissions (EXECUTE)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem THIS REALLY REMOVES PERMISSIONS - FROM EVERYONE.
rem Only the units listed in MCI_KEEP_UNITS are left alone.
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
echo   Clear ALL MCI Permissions - EXECUTE
echo   ----------------------------------------------
echo   THIS REALLY REMOVES PERMISSIONS, FROM EVERYONE
echo   IN EVERY UNIT. Run the DRY RUN shortcut first.
echo.
echo   Kept untouched: the units listed in
echo   MCI_KEEP_UNITS in tools\mci-perm\.env
echo   (default: the emergency medical service section).
echo   If none of them is found in the system, the tool
echo   stops and does nothing.
echo.
echo   Step 1: it walks every unit and lists who is in
echo           it (about 10 minutes, read only).
echo   Step 2: it asks you yes/no with the real number.
echo   Step 3: for each person it unchecks "MCI", presses
echo           confirm, then checks again that the
echo           permission is really gone.
echo.
echo   People who do not have the permission are skipped
echo   without pressing anything.
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

call npm run tool:mci -- clear-all --execute %*

echo.
echo Press any key to close this window.
pause >nul
