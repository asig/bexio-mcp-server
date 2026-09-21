@echo off
setlocal
cd /d "%~dp0"
set SILENT=0
if /i "%~1"=="/silent" set SILENT=1

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: docker.exe not found. Install Docker Desktop ^(Linux containers^).
  if %SILENT%==0 pause
  exit /b 1
)

set ARCHIVE=%~dp0bexio-mcp-server-image.tar.gz
if not exist "%ARCHIVE%" (
  echo ERROR: Missing %ARCHIVE%
  if %SILENT%==0 pause
  exit /b 1
)

echo Loading Docker image from %ARCHIVE% ...
echo This can take several minutes.
docker load -i "%ARCHIVE%"
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo docker load failed with exit code %ERR%.
  if %SILENT%==0 pause
  exit /b %ERR%
)
echo Image loaded successfully.
if %SILENT%==0 pause
exit /b 0
