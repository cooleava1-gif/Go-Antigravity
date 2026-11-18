@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Go-Antigravity.ps1" %*
set "EASYAG_EXIT_CODE=%ERRORLEVEL%"
if not "%EASYAG_EXIT_CODE%"=="0" pause
exit /b %EASYAG_EXIT_CODE%
