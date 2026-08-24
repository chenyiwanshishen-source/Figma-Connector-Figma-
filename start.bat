@echo off
rem Double-click to start the Writable Figma MCP server (Windows).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org ^(LTS^) and try again.
  echo.
  pause
  exit /b 1
)
node server.mjs
echo.
pause
