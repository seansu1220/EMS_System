@echo off
cd /d "%~dp0"
title EMS System

rem Check npm availability
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org then try again.
  echo.
  pause
  exit /b 1
)

rem First run: install packages if needed
if not exist "node_modules\" (
  echo First run detected. Installing packages, please wait a few minutes...
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
echo   Starting EMS System...
echo   A browser window will open shortly.
echo   KEEP THIS WINDOW OPEN while using the system.
echo   Close this window to stop the system.
echo ============================================
echo.

call npm start

echo.
echo System stopped. Press any key to close this window.
pause >nul
