@echo off
cd /d "%~dp0..\.."
title EMS Report - Check ECG Appeal Google Sheet

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org then try again.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Check the ECG appeal Google Sheet
echo   ----------------------------------------
echo   Reads EMS_EKG_ADJUST_SHEET_URL from
echo   tools\ems-report\.env and reports whether
echo   the sheet can be read, its column layout,
echo   and how many appeals can be processed.
echo.
echo   Run this after you change that sheet's
echo   columns - it tells you straight away
echo   whether the monthly report will still
echo   work, instead of finding out after an
echo   hour of case-by-case checking.
echo.
echo   It NEVER prints the sheet URL, and NEVER
echo   prints any cell contents - only column
echo   names and value counts.
echo ============================================
echo.

call npm run tool:ems -- check-ekg-sheet

echo.
echo Press any key to close this window.
pause >nul
