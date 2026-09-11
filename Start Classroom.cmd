@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Start-WebGui.ps1"
if errorlevel 1 (
  echo.
  echo The Web GUI could not be started. Read the message above, then press any key to close.
  pause >nul
)
endlocal
