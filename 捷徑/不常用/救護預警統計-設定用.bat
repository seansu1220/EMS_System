@echo off
cd /d "%~dp0..\.."
title EMS Report - Page Structure Probe (setup only)

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
echo ============================================
echo   PAGE STRUCTURE PROBE  (setup only)
echo   ----------------------------------------
echo   This records field / button / dropdown
echo   NAMES only. It never records any case
echo   data and never takes screenshots.
echo.
echo   YOU ONLY NEED TO SIGN IN.
echo   Everything after that is automatic.
echo   Do not touch the browser once signed in.
echo ============================================
echo.

call npm run tool:ems -- probe

echo.
echo Press any key to close this window.
pause >nul
