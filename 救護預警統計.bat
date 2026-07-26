@echo off
cd /d "%~dp0"
title EMS Report - Prehospital Alert Ratio

rem Check npm availability
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org then try again.
  echo.
  pause
  exit /b 1
)

rem Install packages on first run, or when a new package was added
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
echo   Prehospital Alert Ratio Report
echo   ----------------------------------------
echo   A Chrome window will open at the login
echo   page. Type the CAPTCHA and sign in.
echo   The rest is automatic.
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

call npm run tool:ems -- run %*

echo.
echo Press any key to close this window.
pause >nul
