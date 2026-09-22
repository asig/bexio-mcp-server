Bexio MCP Server — Windows helpers
==================================

Requirements
------------
- Docker Desktop for Windows with Linux containers enabled
- This installer embeds a docker save archive of the Linux image

Quick start
-----------
1. Install Docker Desktop and start it.
2. Start Menu → "Bexio MCP Server" → "Load Docker Image" (if not loaded during setup).
3. Start Menu → "Start Bexio MCP Server".
4. Open http://127.0.0.1:8000/ in a browser.
5. Point Claude Desktop / LibreChat MCP URL at:
     http://127.0.0.1:8000/mcp

Auth
----
The server expects Authorization: Bearer <bexio_access_token> on tool calls,
or you can set BEXIO_API_TOKEN in a docker run override for single-tenant use.

OAuth discovery (for clients that support it):
  http://127.0.0.1:8000/.well-known/oauth-protected-resource/mcp

Stop
----
Start Menu → "Stop Bexio MCP Server"

Files
-----
  run-bexio-mcp.bat      Start the container
  stop-bexio-mcp.bat     Stop/remove the container
  load-image.bat         docker load the embedded .tar.gz
  status-bexio-mcp.bat   Show container status
  config.env             Image name and ports
  bexio-mcp-server-image.tar.gz   Docker image archive


Configuration (config.env)
--------------------------
Same folder as the .bat files (install dir), e.g.:
  C:\Program Files\BexioMCPServer\config.env

If the file is missing, "Start Bexio MCP Server" creates it and opens Notepad.

Example:
  IMAGE_NAME=bexio-mcp-server:latest
  CONTAINER_NAME=bexio-mcp-server
  HOST_PORT=8000
  CONTAINER_PORT=8000
  BEXIO_OAUTH_ISSUER=https://auth.researchmaus.com
  MCP_PUBLIC_URL=http://127.0.0.1:8000

Re-run Start Bexio MCP Server after editing so docker run picks up new -e values.
