@echo off
cd /d "%~dp0.."
title Revoke MCI Permission (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem DRY RUN: it only reports the current state of each person.
rem Nothing is unchecked, nothing is saved.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found. Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "tools\mci-perm\out\progress\" (
  echo.
  echo [NOTHING TO DO] No grant history found.
  echo The revoke list comes from the progress file written when the
  echo permissions were granted - without it there is no way to tell
  echo who was newly granted and who already had the permission.
  echo.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Revoke MCI Permission (DRY RUN)
echo   ----------------------------------------------
echo   Undoes ONLY what was newly granted in the last
echo   run. People who ALREADY had the permission are
echo   not in the list and will not be touched.
echo.
echo   DRY RUN: it just shows each person's current
echo   state. Nothing is changed.
echo.
echo   A browser opens - type the CAPTCHA and sign in.
echo   Then it works through the list on its own.
echo.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ==================================================
echo.

call npm run tool:mci -- revoke %*

echo.
echo Press any key to close this window.
pause >nul
