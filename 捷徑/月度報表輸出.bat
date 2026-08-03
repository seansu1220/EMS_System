@echo off
cd /d "%~dp0.."
title EMS Monthly Reports

rem Check npm availability
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org then try again.
  echo.
  pause
  exit /b 1
)

rem Install packages on first run, or when a new package was added
if not exist "node_modules\playwright-core\" (
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
echo ==================================================
echo   Monthly Reports  ^(last month^)
echo   --------------------------------------------
echo   1. Prehospital Alert Ratio
echo   2. 12-Lead ECG Prehospital Transmission Rate
echo.
echo   A Chrome window will open at the login page.
echo   Type the CAPTCHA and sign in. The rest is
echo   automatic.
echo.
echo   THIS TAKES A LONG TIME. Report 2 checks every
echo   case one by one, which can run for hours.
echo   Progress is saved after each case, so you can
echo   close the window and run it again later - it
echo   will continue from where it stopped.
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ==================================================
echo.

call npm run tool:ems -- monthly %*

echo.
echo Press any key to close this window.
pause >nul
