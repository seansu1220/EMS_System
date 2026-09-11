@echo off
cd /d "%~dp0..\.."
title MCI (Yi Zhan Tong) - Save Login Credentials

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This shortcut only opens the settings file in Notepad. It belongs to the
rem MCI / "yi zhan tong" system (nfaemsap3.nfa.gov.tw) and is NOT related to
rem the ambulance record system - that one has its own shortcut, "set login
rem credentials", editing tools\ems-report\.env instead.

set "ENVFILE=tools\mci-perm\.env"

if not exist "%ENVFILE%" (
  if exist "tools\mci-perm\.env.example" (
    copy "tools\mci-perm\.env.example" "%ENVFILE%" >nul
  )
)

if not exist "%ENVFILE%" (
  echo.
  echo [ERROR] tools\mci-perm\.env.example is missing, so the settings file
  echo could not be created. Please re-download the project folder.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   MCI - save your login account / password
echo   ----------------------------------------
echo   Notepad will open the settings file.
echo   Fill in these lines and SAVE:
echo.
echo     MCI_ENTRY_URL=login page URL   (required)
echo     MCI_USERNAME=your account
echo     MCI_PASSWORD=your password
echo.
echo   The CAPTCHA still needs to be typed by
echo   you every time. Leave the account and
echo   password blank to type them by hand.
echo.
echo   Changed your password? Just fix the
echo   MCI_PASSWORD line here. The next run may
echo   ask for the CAPTCHA again - that is normal.
echo.
echo   NOTE: this is the MCI system only. The
echo   ambulance record system has its own file.
echo.
echo   NOTE: the password is stored as PLAIN
echo   TEXT on this computer. Do not fill it in
echo   on a shared / public machine.
echo ============================================
echo.

notepad "%ENVFILE%"

echo Done. You can close this window.
pause >nul
