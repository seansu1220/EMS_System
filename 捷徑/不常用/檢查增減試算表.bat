@echo off
cd /d "%~dp0..\.."
title EMS Report - Check Adjustment Google Sheet

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
echo   Check the adjustment Google Sheet
echo   ----------------------------------------
echo   Reads EMS_ADJUST_SHEET_URL from
echo   tools\ems-report\.env and reports whether
echo   the sheet can be read, plus its column
echo   layout.
echo.
echo   It NEVER prints the sheet URL, and NEVER
echo   prints any cell contents - only column
echo   names and value counts.
echo ============================================
echo.

call npm run tool:ems -- check-sheet

echo.
echo Press any key to close this window.
pause >nul
