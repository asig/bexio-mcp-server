@echo off
setlocal
cd /d "%~dp0"
set CONTAINER_NAME=bexio-mcp-server
if exist "%~dp0config.env" (
  for /f "usebackq tokens=1* delims==" %%a in ("%~dp0config.env") do (
    if /i "%%a"=="CONTAINER_NAME" set "CONTAINER_NAME=%%b"
  )
)
where docker >nul 2>&1
if errorlevel 1 (
  echo docker not found.
  pause
  exit /b 1
)
docker rm -f %CONTAINER_NAME% 2>nul
echo Container %CONTAINER_NAME% stopped.
pause
endlocal
