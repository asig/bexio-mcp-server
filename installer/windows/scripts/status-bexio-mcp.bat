@echo off
setlocal
cd /d "%~dp0"
set CONTAINER_NAME=bexio-mcp-server
set HOST_PORT=8000
if exist "%~dp0config.env" (
  for /f "usebackq tokens=1* delims==" %%a in ("%~dp0config.env") do (
    if /i "%%a"=="CONTAINER_NAME" set "CONTAINER_NAME=%%b"
    if /i "%%a"=="HOST_PORT" set "HOST_PORT=%%b"
  )
)
where docker >nul 2>&1
if errorlevel 1 (
  echo docker not found.
  pause
  exit /b 1
)
echo === docker ps ^(filter^) ===
docker ps -a --filter "name=%CONTAINER_NAME%"
echo.
echo === health check ===
curl -s -o NUL -w "HTTP %%{http_code}\n" http://127.0.0.1:%HOST_PORT%/ 2>nul || echo curl failed or server not reachable
echo.
pause
endlocal
