@echo off
cd /d "%~dp0..\.."
title EMS ECG Transmission - Trial Run (5 cases)

rem Check npm availability
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org then try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright-core\" (
  echo Installing required packages, please wait a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. See messages above.
    pause
    exit /b 1
  )
)

echo.
echo ==================================================
echo   ECG Transmission Rate - TRIAL RUN
echo   --------------------------------------------
echo   Checks only the FIRST 5 cases, so you can see
echo   whether the arrival time / upload time are
echo   being read correctly before running the whole
echo   month ^(which takes hours^).
echo.
echo   The report it writes is NOT a real report -
echo   only 5 cases were checked.
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ==================================================
echo.

call npm run tool:ems -- ekg --limit=5 %*

echo.
echo Press any key to close this window.
pause >nul
