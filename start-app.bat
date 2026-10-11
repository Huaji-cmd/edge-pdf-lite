@echo off
rem ---------------------------------------------------------------
rem  Double-click this file to run edge-pdf-lite as an application.
rem
rem  Keep this file pure ASCII.  cmd.exe parses .bat files using the
rem  OEM codepage, so non-ASCII bytes in here turn into mojibake or
rem  break the script outright.  All the Chinese output comes from
rem  the Node script instead, which is UTF-8 and prints fine.
rem ---------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found.
  echo       Install it from https://nodejs.org/  then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo.
  echo   [!] No build found in dist\
  echo       Run:  npm install  ^&^&  npm run build
  echo.
  pause
  exit /b 1
)

node scripts\app.mjs %*

if errorlevel 1 pause
