@echo off
cd /d "%~dp0..\.."
title Unlock Queue Watcher (DRY RUN - session test)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem Dry run: signs in, keeps the session alive, but never unlocks anything.
rem Use it to measure how long the sign-in actually survives.
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
echo   Unlock Queue Watcher - DRY RUN
echo   ----------------------------------------
echo   Signs in, then keeps the sign-in alive and
echo   watches the queue - but NEVER unlocks and
echo   NEVER writes anything back.
echo.
echo   What it is good for: leave it running and
echo   see how long the sign-in survives. If the
echo   server drops it, the window says so and
echo   asks you to sign in again.
echo.
echo   Requests that arrive while this runs are
echo   left alone (they stay "pending").
echo.
echo   To stop: close this window, or press Ctrl+C.
echo ============================================
echo.

call npm run tool:ems -- unlock-watch %*

echo.
echo Press any key to close this window.
pause >nul
