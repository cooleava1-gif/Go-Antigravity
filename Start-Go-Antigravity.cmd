@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Go-Antigravity.ps1" %*
set "GO_ANTIGRAVITY_EXIT_CODE=%ERRORLEVEL%"
if not "%GO_ANTIGRAVITY_EXIT_CODE%"=="0" pause
exit /b %GO_ANTIGRAVITY_EXIT_CODE%
