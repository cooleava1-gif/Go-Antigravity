@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Go-Antigravity.ps1" %*
set "GOAGY_EXIT_CODE=%ERRORLEVEL%"
if not "%GOAGY_EXIT_CODE%"=="0" pause
exit /b %GOAGY_EXIT_CODE%
