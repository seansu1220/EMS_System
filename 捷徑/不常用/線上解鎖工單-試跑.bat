@echo off
cd /d "%~dp0..\.."
title Online Unlock Queue (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem Dry run: only lists the pending requests. Nothing is unlocked and nothing
rem is written back. Use it to check the web connection is set up correctly.
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
echo   Online Unlock Queue - DRY RUN
echo   ----------------------------------------
echo   Only lists the unlock requests waiting on
echo   the web page. Nothing is unlocked, nothing
echo   is written back, no browser is opened.
echo.
echo   Use this to check that EMS_WEB_EMAIL and
echo   EMS_WEB_PASSWORD in tools\ems-report\.env
echo   are set up correctly.
echo ============================================
echo.

call npm run tool:ems -- unlock-online %*

echo.
echo Press any key to close this window.
pause >nul
