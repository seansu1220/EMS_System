@echo off
cd /d "%~dp0..\.."
title Revoke DACPR outside keep list (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
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
echo   Revoke DACPR outside keep list (DRY RUN)
echo   ----------------------------------------------
echo   Put TWO lists in the "DACPR" folder next to
echo   this shortcut (see the txt file for details):
echo     - KEEP list: file name starts with the
echo       "keep list" word (people who keep DQC)
echo     - FULL list: the Excel file (any other name)
echo.
echo   People in the FULL list but NOT in the KEEP
echo   list lose DQC (DA-CPR). Nothing else is touched.
echo.
echo   Step 1: compare the two lists (no login yet).
echo           Unsure matches are listed and SKIPPED.
echo   Step 2: for the FIRST 20 PEOPLE only, it signs
echo           in and checks DQC. NOTHING IS CHANGED.
echo.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo ==================================================
echo.

call npm run tool:mci -- revoke-dqc --limit=20 %*

echo.
echo Press any key to close this window.
pause >nul
