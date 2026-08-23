@echo off
cd /d "%~dp0..\.."
title Grant MCI by Squad (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem DRY RUN: it walks the whole flow but never presses the confirm button.
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
echo   Grant MCI by Squad - DRY RUN
echo   ----------------------------------------------
echo   NOTHING WILL BE CHANGED. This run only looks.
echo.
echo   Scope: the 1st - 4th rescue squads and the
echo   special search squad. Change the list with
echo   MCI_GRANT_UNITS in tools\mci-perm\.env
echo   (comma separated).
echo.
echo   Step 1: it lists everyone in those units.
echo   Step 2: for each person it opens the settings
echo           page and stops before the confirm.
echo.
echo   If a unit name is not found in the system, it
echo   stops and prints the real unit list - nothing
echo   is done. Better than silently missing a squad.
echo.
echo   1. A browser opens - type the CAPTCHA, sign in.
echo   2. Leave it running. You can close the window
echo      any time - it resumes where it stopped.
echo.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo ==================================================
echo.

call npm run tool:mci -- grant-units %*

echo.
echo Press any key to close this window.
pause >nul
