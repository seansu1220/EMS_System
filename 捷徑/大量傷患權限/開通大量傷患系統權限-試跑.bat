@echo off
cd /d "%~dp0..\.."
title MCI Permission Grant (DRY RUN)

rem NOTE: keep this file pure ASCII. The console runs in a DBCS code page,
rem where non-ASCII bytes swallow the following characters and break parsing.
rem
rem This shortcut runs the DRY RUN mode: it walks the whole flow but never
rem presses the final confirm button. Use "MCI permission grant (EXECUTE)"
rem once the dry run looks right.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found.
  echo Please install Node.js from https://nodejs.org, or use the portable
  echo version built by the "build portable version" shortcut.
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

if not exist "tools\mci-perm\.env" (
  echo.
  echo [SETUP NEEDED] tools\mci-perm\.env is missing.
  echo Copy tools\mci-perm\.env.example to tools\mci-perm\.env
  echo and fill in MCI_ENTRY_URL - the login page URL of that system.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   MCI Permission Grant (DRY RUN)
echo   ----------------------------------------
echo   EASIEST: drag your Excel file onto this
echo   shortcut - it reads the list from the file.
echo   You can drag SEVERAL files at once; they are
echo   merged into one list (duplicates dropped).
echo   (Columns are found by the header row, so
echo    "name" and "unit" can be in any order.
echo    EVERY worksheet is read - the official form
echo    has one sheet per station. The "(sample)"
echo    row of the template is skipped.)
echo.
echo   Or paste it here instead:
echo   1. Paste the name list. One person per line,
echo      "unit,name". Pasting two columns copied
echo      from Excel is fine. Cannot paste with
echo      Ctrl+V? Just RIGHT-CLICK in this window.
echo   2. Press Enter on an EMPTY line to start.
echo   3. A browser opens - type the CAPTCHA
echo      and sign in. The rest is automatic.
echo.
echo   DRY RUN: it stops right before the final
echo   confirm button. Nothing is changed.
echo   Result: tools\mci-perm\out\result\
echo   Log:    tools\mci-perm\out\last-run.log
echo.
echo   KEEP THIS WINDOW OPEN until it finishes.
echo ============================================
echo.

rem Every file dragged onto this shortcut becomes one --file= argument.
rem "if exist" is the test on purpose: a dragged file always exists, while
rem command-line flags do not. cmd splits --limit=3 at the "=", so testing
rem for a leading "--" would mistake the "3" for a file name.
set "FILEARGS="
set "FILECOUNT=0"
:collect_files
if "%~1"=="" goto files_done
if not exist "%~1" goto next_arg
set FILEARGS=%FILEARGS% --file="%~1"
set /a FILECOUNT+=1
:next_arg
shift
goto collect_files
:files_done

rem No files dragged? Pass the original command line through untouched,
rem so flags like --limit=3 survive (shift does not change %*).
if %FILECOUNT% GTR 0 goto run_with_files
call npm run tool:mci -- grant %*
goto after_run
:run_with_files
echo Name list files: %FILECOUNT%
echo.
call npm run tool:mci -- grant %FILEARGS%
:after_run

echo.
echo Press any key to close this window.
pause >nul
