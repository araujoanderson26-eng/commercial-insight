@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Atualizar.ps1"
set "TASK_UPDATE_EXIT=%ERRORLEVEL%"
if not "%TASK_UPDATE_EXIT%"=="0" pause
exit /b %TASK_UPDATE_EXIT%
