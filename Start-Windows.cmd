@echo off
setlocal
cd /d "%~dp0"
if exist "WINDOWS-PREBUILT.txt" (
  powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\windows.ps1" -Prebuilt %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\windows.ps1" %*
)
set "result=%errorlevel%"
if not "%result%"=="0" (
  echo.
  echo Remote Control could not start. See the error above.
  pause
)
exit /b %result%
