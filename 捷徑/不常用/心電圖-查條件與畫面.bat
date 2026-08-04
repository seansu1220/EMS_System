@echo off
cd /d "%~dp0..\.."
title EMS ECG - Diagnose

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
echo   ECG - Diagnose conditions and screens
echo   --------------------------------------------
echo   Answers two questions in ONE login:
echo.
echo   1. How "EKG check" and "12-lead ECG" overlap
echo      ^(counts A, B and their intersection^)
echo   2. What the "transmission record" button and
echo      the in-case "upload" screen actually show
echo.
echo   Produces NO report - it only looks and reports.
echo   Takes about 5 minutes.
echo ==================================================
echo.

call npm run tool:ems -- ekg-diag %*

echo.
echo Press any key to close this window.
pause >nul
