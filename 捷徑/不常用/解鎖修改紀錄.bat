@echo off
cd /d "%~dp0..\.."
title Unlock Revision Report (last month by default)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem Read-only: lists every case unlocked in the period (by unlock time):
rem cases not closed yet, and for closed cases what was changed
rem (before -> after) plus the reason the requester entered.
rem Output contains patient data and stays on this computer.
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
echo   Unlock Revision Report - READ ONLY
echo   ----------------------------------------
echo   Press Enter twice for LAST MONTH,
echo   or type a start / end date (2026-10-01).
echo   No login to the EMS system is needed.
echo   Report: tools\ems-report\out\internal\
echo ============================================
echo.

set "FROM="
set "TO="
set /p "FROM=  [from] "
if not defined FROM goto lastMonth
set /p "TO=  [to]   "
if not defined TO goto lastMonth
call npm run tool:ems -- revision-report --from=%FROM% --to=%TO% %*
goto done

:lastMonth
call npm run tool:ems -- revision-report %*

:done
echo.
echo Press any key to close this window.
pause >nul
