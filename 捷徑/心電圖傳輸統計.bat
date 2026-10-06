@echo off
cd /d "%~dp0.."
title EMS 12-Lead ECG Transmission Rate

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
if not exist "node_modules\tesseract.js\" (
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
echo   12-Lead ECG Prehospital Transmission Rate
echo   --------------------------------------------
echo   A Chrome window will open at the login page.
echo   Type the CAPTCHA and sign in. The rest is
echo   automatic.
echo.
echo   THIS TAKES A LONG TIME - it opens every case
echo   one by one and can run for hours. Progress is
echo   saved after each case, so you may close the
echo   window and run this again later. It continues
echo   from where it stopped.
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ==================================================
echo.

set "EMS_MONTH="
set /p "EMS_MONTH=Month to run, format 2026-08 (just press Enter for last month): "
echo.

if "%EMS_MONTH%"=="" (
  echo Running for LAST MONTH ...
  echo.
  call npm run tool:ems -- ekg %*
) else (
  echo Running for %EMS_MONTH% ...
  echo.
  call npm run tool:ems -- ekg --month=%EMS_MONTH% %*
)

echo.
echo ==================================================
echo   Finished. What to do next:
echo.
echo   1. Read the summary printed above.
echo   2. The folder that just opened holds the review
echo      list for this month - the summary above
echo      printed its exact file name. Open it, fill
echo      in the "your decision" column, save, then
echo      run this shortcut again for the SAME month.
echo ==================================================
echo.
start "" "tools\ems-report\out\internal"
echo Press any key to close this window.
pause >nul
