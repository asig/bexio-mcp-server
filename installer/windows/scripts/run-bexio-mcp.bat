@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set IMAGE_NAME=bexio-mcp-server:latest
set CONTAINER_NAME=bexio-mcp-server
set HOST_PORT=8000
set CONTAINER_PORT=8000

if exist "%~dp0config.env" (
  for /f "usebackq tokens=1* delims==" %%a in ("%~dp0config.env") do (
    if /i "%%a"=="IMAGE_NAME" set "IMAGE_NAME=%%b"
    if /i "%%a"=="CONTAINER_NAME" set "CONTAINER_NAME=%%b"
    if /i "%%a"=="HOST_PORT" set "HOST_PORT=%%b"
    if /i "%%a"=="CONTAINER_PORT" set "CONTAINER_PORT=%%b"
  )
)

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: docker.exe not found. Install Docker Desktop and enable Linux containers.
  pause
  exit /b 1
)

docker image inspect %IMAGE_NAME% >nul 2>&1
if errorlevel 1 (
  echo Image %IMAGE_NAME% not found. Loading from archive if present...
  if exist "%~dp0bexio-mcp-server-image.tar.gz" (
    call "%~dp0load-image.bat" /silent
  ) else (
    echo ERROR: No image and no bexio-mcp-server-image.tar.gz in %~dp0
    pause
    exit /b 1
  )
)

docker rm -f %CONTAINER_NAME% >nul 2>&1

echo Starting %CONTAINER_NAME% on http://127.0.0.1:%HOST_PORT%/
docker run -d --name %CONTAINER_NAME% -p %HOST_PORT%:%CONTAINER_PORT% %IMAGE_NAME%
if errorlevel 1 (
  echo Failed to start container.
  pause
  exit /b 1
)

echo.
echo Bexio MCP Server is running.
echo   Health:  http://127.0.0.1:%HOST_PORT%/
echo   MCP:     http://127.0.0.1:%HOST_PORT%/mcp
echo   OAuth:   http://127.0.0.1:%HOST_PORT%/.well-known/oauth-protected-resource/mcp
echo.
echo Point Claude Desktop / LibreChat at: http://127.0.0.1:%HOST_PORT%/mcp
echo Stop with: stop-bexio-mcp.bat
echo.
pause
endlocal
