@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\init-git-for-github.cjs
if errorlevel 1 pause
exit /b %ERRORLEVEL%
