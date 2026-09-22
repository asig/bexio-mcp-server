@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "CONFIG=%~dp0config.env"

REM Create config.env on first run if missing
if not exist "%CONFIG%" (
  echo Creating default config.env ...
  (
    echo # Bexio MCP Server configuration
    echo IMAGE_NAME=ghcr.io/asig/bexio-mcp-server:latest
    echo CONTAINER_NAME=bexio-mcp-server
    echo HOST_PORT=8000
    echo CONTAINER_PORT=8000
    echo.
    echo # OAuth discovery — set to your auth bridge URL
    echo BEXIO_OAUTH_ISSUER=https://auth.researchmaus.com
    echo MCP_PUBLIC_URL=http://127.0.0.1:8000
    echo.
    echo # Optional: single-tenant token ^(leave empty for OAuth / Bearer only^)
    echo # BEXIO_API_TOKEN=
  ) > "%CONFIG%"
  echo.
  echo Created: %CONFIG%
  echo Edit that file to change ports or OAuth URLs, then run this script again.
  echo.
  notepad "%CONFIG%"
  echo.
  pause
)

set IMAGE_NAME=bexio-mcp-server:latest
set CONTAINER_NAME=bexio-mcp-server
set HOST_PORT=8000
set CONTAINER_PORT=8000
set BEXIO_OAUTH_ISSUER=
set MCP_PUBLIC_URL=
set BEXIO_API_TOKEN=
set BEXIO_OAUTH_SCOPES=

REM Load KEY=VALUE from config.env (skip comments and blank lines)
for /f "usebackq eol=# tokens=1* delims==" %%a in ("%CONFIG%") do (
  if not "%%a"=="" (
    set "k=%%a"
    set "v=%%b"
    REM trim is limited in bat; keys should have no spaces
    if /i "!k!"=="IMAGE_NAME" set "IMAGE_NAME=!v!"
    if /i "!k!"=="CONTAINER_NAME" set "CONTAINER_NAME=!v!"
    if /i "!k!"=="HOST_PORT" set "HOST_PORT=!v!"
    if /i "!k!"=="CONTAINER_PORT" set "CONTAINER_PORT=!v!"
    if /i "!k!"=="BEXIO_OAUTH_ISSUER" set "BEXIO_OAUTH_ISSUER=!v!"
    if /i "!k!"=="MCP_PUBLIC_URL" set "MCP_PUBLIC_URL=!v!"
    if /i "!k!"=="BEXIO_API_TOKEN" set "BEXIO_API_TOKEN=!v!"
    if /i "!k!"=="BEXIO_OAUTH_SCOPES" set "BEXIO_OAUTH_SCOPES=!v!"
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

set "DOCKER_ENV="
if defined BEXIO_OAUTH_ISSUER if not "!BEXIO_OAUTH_ISSUER!"=="" set "DOCKER_ENV=!DOCKER_ENV! -e BEXIO_OAUTH_ISSUER=!BEXIO_OAUTH_ISSUER!"
if defined MCP_PUBLIC_URL if not "!MCP_PUBLIC_URL!"=="" set "DOCKER_ENV=!DOCKER_ENV! -e MCP_PUBLIC_URL=!MCP_PUBLIC_URL!"
if defined BEXIO_API_TOKEN if not "!BEXIO_API_TOKEN!"=="" set "DOCKER_ENV=!DOCKER_ENV! -e BEXIO_API_TOKEN=!BEXIO_API_TOKEN!"
if defined BEXIO_OAUTH_SCOPES if not "!BEXIO_OAUTH_SCOPES!"=="" set "DOCKER_ENV=!DOCKER_ENV! -e BEXIO_OAUTH_SCOPES=!BEXIO_OAUTH_SCOPES!"

echo Starting %CONTAINER_NAME% on http://127.0.0.1:%HOST_PORT%/
echo Config: %CONFIG%
docker run -d --name %CONTAINER_NAME% -p %HOST_PORT%:%CONTAINER_PORT% %DOCKER_ENV% %IMAGE_NAME%
if errorlevel 1 (
  echo Failed to start container.
  pause
  exit /b 1
)

echo.
echo Bexio MCP Server is running.
echo   Health:  http://127.0.0.1:%HOST_PORT%/
echo   MCP:     http://127.0.0.1:%HOST_PORT%/mcp
echo   Config:  %CONFIG%
echo.
echo Edit config.env and re-run this script to change env vars.
echo Stop with: stop-bexio-mcp.bat
echo.
pause
endlocal
