@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar.ps1" %*
set "TASK_INSTALL_EXIT=%ERRORLEVEL%"
if not "%TASK_INSTALL_EXIT%"=="0" pause
exit /b %TASK_INSTALL_EXIT%
