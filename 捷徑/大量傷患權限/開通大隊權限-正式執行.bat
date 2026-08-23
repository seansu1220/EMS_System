@echo off
cd /d "%~dp0..\.."
title Grant MCI by Squad (EXECUTE)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem THIS REALLY GRANTS PERMISSIONS to everyone in the listed squads.
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
echo   Grant MCI by Squad - EXECUTE
echo   ----------------------------------------------
echo   THIS REALLY GRANTS PERMISSIONS.
echo   Run the DRY RUN shortcut first.
echo.
echo   Scope: the 1st - 4th rescue squads and the
echo   special search squad. Change the list with
echo   MCI_GRANT_UNITS in tools\mci-perm\.env
echo   (comma separated).
echo.
echo   Step 1: it lists everyone in those units.
echo   Step 2: it asks you yes/no with the real number.
echo   Step 3: for each person it sets the MCI role to
echo           "MCI002", presses confirm, then checks
echo           again that it was really saved.
echo.
echo   People who already have MCI002 are skipped
echo   without pressing anything.
echo.
echo   If a unit name is not found in the system, it
echo   stops and prints the real unit list - nothing
echo   is done. Better than silently missing a squad.
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

call npm run tool:mci -- grant-units --execute %*

echo.
echo Press any key to close this window.
pause >nul
