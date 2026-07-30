@echo off
cd /d "%~dp0.."
title Build Portable EMS Tool

echo.
echo ============================================
echo   Build Portable EMS Tool
echo   ----------------------------------------
echo   Packs the tool + Node.js + packages into
echo   one folder you can copy to a USB drive
echo   and run on a PC without Node.js.
echo.
echo   Run this on a PC WITH internet access.
echo   Downloads about 30MB, takes a few minutes.
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\make-portable.ps1"

echo.
echo Press any key to close this window.
pause >nul
