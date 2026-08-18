@echo off
cd /d "%~dp0..\.."
title Duty Watch (DRY RUN)

rem NOTE: keep this file pure ASCII (DBCS console breaks on non-ASCII bytes).
rem
rem Same as the normal duty watch, but it never acts:
rem unlock requests stay pending, permission grants stop before confirm.
rem Use it to measure how long each login survives.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found. Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   Duty Watch (DRY RUN - nothing is changed)
echo   ----------------------------------------------
echo   Two browser windows open; sign in to each.
echo   Unlock requests stay in "pending".
echo   Pasted name lists walk the flow but never
echo   press the confirm button.
echo.
echo   Useful for: measuring how long each system
echo   keeps you signed in with the heartbeat on.
echo.
echo   Log: tools\duty-watch\out\duty-watch.log
echo ==================================================
echo.

call npm run tool:duty -- %*

echo.
echo Press any key to close this window.
pause >nul
