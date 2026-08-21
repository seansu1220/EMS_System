@echo off
cd /d "%~dp0.."
title Revoke MCI Permission (EXECUTE)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem THIS REALLY REMOVES PERMISSIONS.
rem The list comes from the grant progress file and contains ONLY the
rem people who were newly granted. Those who already had the permission
rem are not in it and are never touched.
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
  echo Without the progress file there is no way to tell who was newly
  echo granted and who already had the permission, so nothing is done.
  echo.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Revoke MCI Permission (EXECUTE)
echo   ----------------------------------------------
echo   THIS REALLY REMOVES PERMISSIONS.
echo   Run the DRY RUN shortcut first.
echo.
echo   For each person it unchecks "MCI" and presses
echo   the confirm button, then checks again that the
echo   permission is really gone.
echo.
echo   ONLY the newly granted people are in the list.
echo   Those who already had the permission are NOT
echo   touched.
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

call npm run tool:mci -- revoke --execute %*

echo.
echo Press any key to close this window.
pause >nul
