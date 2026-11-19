@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar.ps1" -SomenteRegistro
set "TASK_REGISTER_EXIT=%ERRORLEVEL%"
if not "%TASK_REGISTER_EXIT%"=="0" pause
exit /b %TASK_REGISTER_EXIT%
