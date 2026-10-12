@echo off
cd /d "%~dp0..\.."
title EMS Report - Print Filter Guides (PDF)

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
echo   Print the filter guides as PDF
echo   ----------------------------------------
echo   Two short guides for squad members who
echo   ask "how is this ratio filtered?":
echo     - Prehospital alert ratio
echo     - 12-lead ECG transmission rate
echo.
echo   No login needed. The folder opens when
echo   done. The monthly report also puts these
echo   two PDFs into its "for squads" folder,
echo   so you only need this to get them now.
echo ============================================
echo.

call npm run tool:ems -- guides

echo.
echo Press any key to close this window.
pause >nul
