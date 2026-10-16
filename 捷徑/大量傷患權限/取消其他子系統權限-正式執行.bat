@echo off
cd /d "%~dp0..\.."
title Clear Other SSO Subsystems (EXECUTE)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem THIS REALLY REMOVES PERMISSIONS of every subsystem except MCI, ACS, DQC.
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
echo   Clear Other SSO Subsystems (EXECUTE)
echo   ----------------------------------------------
echo   THIS REALLY REMOVES PERMISSIONS.
echo   Run the DRY RUN shortcut first.
echo.
echo   Scope: EVERYONE (all units). Change it with
echo   SSO_KEEP_UNITS in tools\mci-perm\.env.
echo.
echo   Cleared: ATM ADG AAM CPM DSM FOS MMS FIS PAC EWFA
echo   Kept:    MCI ACS DQC  (never touched)
echo.
echo   Step 1: it presses "show all" and reads every
echo           page (about 10 minutes, read only).
echo   Step 2: it asks you yes/no with the real number.
echo   Step 3: for each person it unchecks those
echo           subsystems, presses confirm, then checks
echo           again that they are really gone.
echo.
echo   People with none of them checked are skipped
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

call npm run tool:mci -- clear-others --execute %*

echo.
echo Press any key to close this window.
pause >nul
