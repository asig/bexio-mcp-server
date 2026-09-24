;------------------------------------------------------------------------------
; Bexio MCP Server — Windows installer (NSIS)
;
; Build on Linux:
;   makensis -DOUTFILE=BexioMCPServer-Setup.exe bexio-mcp-server.nsi
;
; Prerequisites on the build host:
;   apt install nsis
;   Place docker image export next to this script (or pass -DIMAGE_TAR=...):
;     docker save bexio-mcp-server:latest | gzip > bexio-mcp-server-image.tar.gz
;
; The installer does NOT install Docker Desktop. It:
;   - Shows a page asking the user to install Docker Desktop if missing
;   - Copies the image archive + helper scripts
;   - Optionally loads the image if docker.exe is on PATH
;   - Creates Start Menu shortcuts to run/stop the container
;------------------------------------------------------------------------------

!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "Bexio MCP Server"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "2.5.0"
!endif
; PE version resource must be exactly N.N.N.N (digits only). CI tags like 0.0.0-ci.1 are invalid.
!ifndef VI_PRODUCT_VERSION
  !define VI_PRODUCT_VERSION "0.0.0.1"
!endif
!ifndef PRODUCT_PUBLISHER
  !define PRODUCT_PUBLISHER "Bexio MCP"
!endif
!ifndef IMAGE_NAME
  !define IMAGE_NAME "bexio-mcp-server:latest"
!endif
!ifndef IMAGE_TAR
  !define IMAGE_TAR "bexio-mcp-server-image.tar.gz"
!endif
!ifndef OUTFILE
  !define OUTFILE "BexioMCPServer-Setup-${PRODUCT_VERSION}.exe"
!endif
!ifndef INSTALL_DIR_NAME
  !define INSTALL_DIR_NAME "BexioMCPServer"
!endif

; Default host port published by the container
!ifndef CONTAINER_PORT
  !define CONTAINER_PORT "8000"
!endif

!define DOCKER_DESKTOP_URL "https://www.docker.com/products/docker-desktop/"
!define DOCKER_DESKTOP_DOWNLOAD_URL "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"

Name "${PRODUCT_NAME}"
OutFile "${OUTFILE}"
Unicode true
InstallDir "$PROGRAMFILES64\${INSTALL_DIR_NAME}"
InstallDirRegKey HKLM "Software\${INSTALL_DIR_NAME}" "InstallPath"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

; Custom finish text
!define MUI_FINISHPAGE_TITLE "Installation complete"
!define MUI_FINISHPAGE_TEXT \
  "${PRODUCT_NAME} was installed.$\r$\n$\r$\n\
If Docker Desktop is installed and running, use the Start Menu shortcuts to load the image and start the server.$\r$\n$\r$\n\
MCP URL: http://127.0.0.1:${CONTAINER_PORT}/mcp"
!define MUI_FINISHPAGE_RUN "$INSTDIR\run-bexio-mcp.bat"
!define MUI_FINISHPAGE_RUN_TEXT "Start Bexio MCP Server now"
!define MUI_FINISHPAGE_RUN_NOTCHECKED

Var DockerFound
Var DockerDialog
Var DockerStatusLabel
Var DockerHintLabel
Var DockerLink
Var BtnOpenDownload
Var BtnRecheck

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"
Page custom DockerDesktopPageCreate DockerDesktopPageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VI_PRODUCT_VERSION}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "Installer for ${PRODUCT_NAME} (Docker image + helpers)"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) ${PRODUCT_PUBLISHER}"

;------------------------------------------------------------------------------
; Detect docker.exe on PATH (0 = found, non-zero = missing)
;------------------------------------------------------------------------------
Function CheckDocker
  StrCpy $DockerFound "0"
  nsExec::ExecToStack 'cmd /c "where docker >nul 2>nul"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    ; Also verify docker responds (daemon may be stopped)
    nsExec::ExecToStack 'cmd /c "docker version --format {{.Server.Version}} 2>nul"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      StrCpy $DockerFound "2"  ; found and daemon reachable
    ${Else}
      StrCpy $DockerFound "1"  ; docker.exe on PATH but daemon not ready
    ${EndIf}
  ${Else}
    StrCpy $DockerFound "0"
  ${EndIf}
FunctionEnd

;------------------------------------------------------------------------------
; Custom page: Docker Desktop requirement
;------------------------------------------------------------------------------
Function DockerDesktopPageCreate
  !insertmacro MUI_HEADER_TEXT "Docker Desktop required" \
    "This product runs as a Linux container inside Docker Desktop."

  Call CheckDocker

  nsDialogs::Create 1018
  Pop $DockerDialog
  ${If} $DockerDialog == error
    Abort
  ${EndIf}

  ; Keep controls within the MUI inner dialog (~120u tall) so buttons stay visible.
  ${NSD_CreateLabel} 0 0 100% 28u \
    "Bexio MCP Server is a Docker image. Install Docker Desktop for Windows (Linux containers) before starting the server."
  Pop $0

  ${NSD_CreateLabel} 0 32u 100% 20u ""
  Pop $DockerStatusLabel

  ${NSD_CreateLabel} 0 54u 100% 28u \
    "1. Install Docker Desktop from the official site.$\r$\n\
2. Start it and wait until it is running.$\r$\n\
3. Click $\"Check again$\", then Next."
  Pop $DockerHintLabel

  ${NSD_CreateLink} 0 88u 100% 12u "Open Docker Desktop download page"
  Pop $DockerLink
  ${NSD_OnClick} $DockerLink OnDockerLink

  ${NSD_CreateButton} 0 104u 140u 16u "Download Docker Desktop"
  Pop $BtnOpenDownload
  ${NSD_OnClick} $BtnOpenDownload OnDockerDownload

  ${NSD_CreateButton} 150u 104u 100u 16u "Check again"
  Pop $BtnRecheck
  ${NSD_OnClick} $BtnRecheck OnDockerRecheck

  Call UpdateDockerStatusUI

  nsDialogs::Show
FunctionEnd

Function UpdateDockerStatusUI
  ${If} $DockerFound == "2"
    ${NSD_SetText} $DockerStatusLabel \
      "Status: Docker Desktop detected and responding. You can continue."
  ${ElseIf} $DockerFound == "1"
    ${NSD_SetText} $DockerStatusLabel \
      "Status: docker.exe found, but the Docker engine is not running yet. Start Docker Desktop, then click Check again."
  ${Else}
    ${NSD_SetText} $DockerStatusLabel \
      "Status: Docker was NOT found on this computer. Please install Docker Desktop first."
  ${EndIf}
FunctionEnd

Function OnDockerLink
  ExecShell "open" "${DOCKER_DESKTOP_URL}"
FunctionEnd

Function OnDockerDownload
  ; Direct installer link (amd64). User may need arm64 from the website on Snapdragon PCs.
  ExecShell "open" "${DOCKER_DESKTOP_DOWNLOAD_URL}"
FunctionEnd

Function OnDockerRecheck
  Call CheckDocker
  Call UpdateDockerStatusUI
  ${If} $DockerFound == "2"
    MessageBox MB_ICONINFORMATION "Docker Desktop is available. Click Next to continue installation."
  ${ElseIf} $DockerFound == "1"
    MessageBox MB_ICONEXCLAMATION \
      "docker.exe is installed, but the engine is not ready.$\r$\n$\r$\n\
Start Docker Desktop from the Start Menu, wait until it says $\"Docker Desktop is running$\", then click Check again."
  ${Else}
    MessageBox MB_ICONEXCLAMATION \
      "Docker is still not available.$\r$\n$\r$\n\
Install Docker Desktop, reboot if asked, start it, then click Check again."
  ${EndIf}
FunctionEnd

Function DockerDesktopPageLeave
  Call CheckDocker
  ${If} $DockerFound == "0"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "Docker Desktop was not detected.$\r$\n$\r$\n\
You can continue installing the files, but you will not be able to run the server until Docker Desktop is installed and running.$\r$\n$\r$\n\
Continue anyway?" \
      IDYES docker_leave_ok
    Abort  ; stay on page
    docker_leave_ok:
  ${ElseIf} $DockerFound == "1"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Docker is installed but the engine does not appear to be running.$\r$\n$\r$\n\
Continue installation anyway? (You can start Docker Desktop later and use Load Docker Image from the Start Menu.)" \
      IDYES docker_leave_ok2
    Abort
    docker_leave_ok2:
  ${EndIf}
FunctionEnd

;------------------------------------------------------------------------------
; Install
;------------------------------------------------------------------------------
Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Helper scripts
  File "scripts\run-bexio-mcp.bat"
  File "scripts\stop-bexio-mcp.bat"
  File "scripts\load-image.bat"
  File "scripts\status-bexio-mcp.bat"
  File "scripts\README-WINDOWS.txt"

  File "LICENSE.txt"

  ; Docker image archive (large) — must exist at build time
  IfFileExists "${IMAGE_TAR}" 0 no_image
    File /oname=bexio-mcp-server-image.tar.gz "${IMAGE_TAR}"
    Goto image_done
  no_image:
    DetailPrint "WARNING: ${IMAGE_TAR} not found at build time — installer will not embed the image."
    DetailPrint "Place the tar.gz next to the .nsi or pass -DIMAGE_TAR=path when running makensis."
  image_done:

  ; Write config used by the .bat scripts
  ; Default config.env for run-bexio-mcp.bat
  FileOpen $0 "$INSTDIR\config.env" w
  FileWrite $0 "# Edit this file, then use Start Bexio MCP Server$\r$\n"
  FileWrite $0 "IMAGE_NAME=${IMAGE_NAME}$\r$\n"
  FileWrite $0 "CONTAINER_NAME=bexio-mcp-server$\r$\n"
  FileWrite $0 "HOST_PORT=${CONTAINER_PORT}$\r$\n"
  FileWrite $0 "CONTAINER_PORT=8000$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "BEXIO_OAUTH_ISSUER=https://auth.researchmaus.com$\r$\n"
  FileWrite $0 "MCP_PUBLIC_URL=http://127.0.0.1:${CONTAINER_PORT}$\r$\n"
  FileClose $0

  ; Uninstaller
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Registry (Add/Remove Programs)
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTALL_DIR_NAME}" \
    "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTALL_DIR_NAME}" \
    "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTALL_DIR_NAME}" \
    "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTALL_DIR_NAME}" \
    "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "Software\${INSTALL_DIR_NAME}" "InstallPath" "$INSTDIR"

  ; Start Menu
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Start Bexio MCP Server.lnk" \
    "$INSTDIR\run-bexio-mcp.bat" "" "$INSTDIR\run-bexio-mcp.bat" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Stop Bexio MCP Server.lnk" \
    "$INSTDIR\stop-bexio-mcp.bat" "" "$INSTDIR\stop-bexio-mcp.bat" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Load Docker Image.lnk" \
    "$INSTDIR\load-image.bat" "" "$INSTDIR\load-image.bat" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Status.lnk" \
    "$INSTDIR\status-bexio-mcp.bat" "" "$INSTDIR\status-bexio-mcp.bat" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" \
    "$INSTDIR\Uninstall.exe"
  ; Shortcut to Docker Desktop download for users who skipped the page
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Get Docker Desktop.lnk" \
    "${DOCKER_DESKTOP_URL}" "" "" 0

  ; Re-check docker at install time
  Call CheckDocker
  ${If} $DockerFound == "2"
    DetailPrint "Docker found and responding."
  ${ElseIf} $DockerFound == "1"
    DetailPrint "docker.exe found but engine not ready."
  ${Else}
    DetailPrint "Docker not found. User must install Docker Desktop to run the server."
  ${EndIf}

  ; Offer to load image if docker engine is ready and archive exists
  IfFileExists "$INSTDIR\bexio-mcp-server-image.tar.gz" 0 skip_load
    ${If} $DockerFound == "2"
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Docker is running. Load the Bexio MCP image into Docker now?$\r$\n$\r$\nThis may take a few minutes." \
        IDNO skip_load
      DetailPrint "Loading Docker image (docker load)..."
      nsExec::ExecToLog '"$INSTDIR\load-image.bat" /silent'
      Pop $0
      ${If} $0 == 0
        DetailPrint "Image load finished (exit code 0)."
      ${Else}
        DetailPrint "Image load returned exit code $0. You can run Load Docker Image from the Start Menu later."
      ${EndIf}
    ${EndIf}
  skip_load:
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'cmd /c "docker rm -f bexio-mcp-server 2>nul"'
  Pop $0

  Delete "$INSTDIR\run-bexio-mcp.bat"
  Delete "$INSTDIR\stop-bexio-mcp.bat"
  Delete "$INSTDIR\load-image.bat"
  Delete "$INSTDIR\status-bexio-mcp.bat"
  Delete "$INSTDIR\README-WINDOWS.txt"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\config.env"
  Delete "$INSTDIR\bexio-mcp-server-image.tar.gz"
  Delete "$INSTDIR\Uninstall.exe"

  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTALL_DIR_NAME}"
  DeleteRegKey HKLM "Software\${INSTALL_DIR_NAME}"
SectionEnd
