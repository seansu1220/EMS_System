@echo off
cd /d "%~dp0..\.."
title Record Sheet Sample (masked layout)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem Read-only: opens 3 recent record sheets, keeps only the text that is the
rem same on all of them (the printed form labels) and masks everything else.
rem Writes the masked layout to tools\ems-report\out\internal\. No PDF is saved.
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
echo   Record Sheet Sample - READ ONLY
echo   ----------------------------------------
echo   Type the captcha in the browser when asked.
echo   Output (masked): tools\ems-report\out\
echo     internal\ (folder for record sheet samples)
echo ============================================
echo.

call npm run tool:ems -- sheet-sample %*

echo.
echo Press any key to close this window.
pause >nul
