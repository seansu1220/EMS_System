@echo off
cd /d "%~dp0..\.."
title Revision Check (before unlock vs after closed)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem Read-only: for every case unlocked (and backed up) before, checks whether
rem it is closed again; if so, compares the record sheet before unlock with the
rem one after closing and lists the differences. Nothing in the system changes.
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
echo   Revision Check - READ ONLY
echo   ----------------------------------------
echo   For every unlocked case: closed again?
echo   If closed, compare the sheet before unlock
echo   with the sheet after closing.
echo.
echo   The online unlock tools already do this
echo   every time they start (and daily while
echo   watching, or when the admin presses
echo   "Revision Check" on the web page).
echo   Use this one to see it now.
echo   Report: tools\ems-report\out\internal\
echo ============================================
echo.

call npm run tool:ems -- revision-check %*

echo.
echo Press any key to close this window.
pause >nul
