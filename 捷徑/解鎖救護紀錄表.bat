@echo off
cd /d "%~dp0.."
title EMS Record Unlock (DRY RUN)

rem This shortcut needs Node.js installed on this PC.
rem For a PC where you cannot install anything, run "建立可攜版.bat" first
rem and use the launcher inside the generated folder instead.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org, or use the portable
  echo version created by "建立可攜版.bat".
  echo.
  pause
  exit /b 1
)

rem Install packages on first run, or when a new package was added
if not exist "node_modules\pdfjs-dist\" (
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
echo ============================================
echo   Unlock Ambulance Records (DRY RUN)
echo   ----------------------------------------
echo   1. Paste TEMSIS numbers, one per line.
echo   2. Press Enter on an empty line to start.
echo   3. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo.
echo   This version ONLY reports which record
echo   would be unlocked. It never clicks it.
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

call npm run tool:ems -- unlock %*

echo.
echo Press any key to close this window.
pause >nul
