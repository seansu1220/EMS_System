@echo off
cd /d "%~dp0"
title EMS Report - Save Login Credentials

set "ENVFILE=tools\ems-report\.env"

if not exist "%ENVFILE%" (
  if exist "tools\ems-report\.env.example" (
    copy "tools\ems-report\.env.example" "%ENVFILE%" >nul
  )
)

echo.
echo ============================================
echo   Save your login account / password
echo   ----------------------------------------
echo   Notepad will open the settings file.
echo   Fill in the two lines and SAVE:
echo.
echo     EMS_USERNAME=your account
echo     EMS_PASSWORD=your password
echo.
echo   The CAPTCHA still needs to be typed by
echo   you every time. Leave blank to disable.
echo.
echo   NOTE: the password is stored as PLAIN
echo   TEXT on this computer. Do not fill it in
echo   on a shared / public machine.
echo ============================================
echo.

notepad "%ENVFILE%"

echo Done. You can close this window.
pause >nul
