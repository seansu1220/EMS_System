@echo off
cd /d "%~dp0..\.."
title Device Reset (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem Dry run: signs in, opens System Settings - Device Management and lists
rem the devices stuck in "continuous data" status. Nothing is changed.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Device Reset - DRY RUN
echo   ----------------------------------------
echo   Signs in, opens Device Management and lists
echo   the devices stuck in "continuous data".
echo   It NEVER presses lock or enable.
echo.
echo   The online unlock tools already do the real
echo   reset after every sign-in. Use this one to
echo   check the page is read correctly.
echo   Log: tools\ems-report\out\last-run.log
echo ============================================
echo.

call npm run tool:ems -- device-reset %*

echo.
echo Press any key to close this window.
pause >nul
