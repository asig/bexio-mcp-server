# Windows installer (NSIS) — build on Linux

Produces a Windows `.exe` installer that embeds the **Linux** Docker image
and helper `.bat` scripts. Target PCs need **Docker Desktop (Linux containers)**.

## On the Linux build host

### 1. Install NSIS

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y nsis

# Fedora
# sudo dnf install mingw32-nsis
```

### 2. Build and export the Docker image

From the repo root (where the `Dockerfile` is):

```bash
docker build -t bexio-mcp-server:latest .
docker save bexio-mcp-server:latest | gzip > installer/windows/bexio-mcp-server-image.tar.gz
```

### 3. Compile the installer

```bash
cd installer/windows
makensis -DPRODUCT_VERSION=2.5.0 bexio-mcp-server.nsi
```

Output: `BexioMCPServer-Setup-2.5.0.exe`

Optional defines:

| Define | Default | Meaning |
|--------|---------|---------|
| `PRODUCT_VERSION` | `2.5.0` | Version shown in the installer |
| `IMAGE_NAME` | `bexio-mcp-server:latest` | Tag written into `config.env` |
| `IMAGE_TAR` | `bexio-mcp-server-image.tar.gz` | Path to the image archive |
| `OUTFILE` | `BexioMCPServer-Setup-….exe` | Output exe name |
| `CONTAINER_PORT` | `8000` | Host port published on Windows |

Example:

```bash
makensis \
  -DPRODUCT_VERSION=2.5.0 \
  -DIMAGE_TAR=/path/to/bexio-mcp-server-image.tar.gz \
  -DOUTFILE=BexioMCPServer-Setup.exe \
  bexio-mcp-server.nsi
```

## Installer pages

After the license page, a **Docker Desktop** page appears that:

- Detects whether `docker` is on PATH and whether the engine responds
- Links to the Docker Desktop website / download
- Lets the user **Check again** after installing/starting Docker
- Allows continuing without Docker (with a warning); the server will not run until Docker is available

## On Windows (end user)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and use **Linux containers**.
2. Run `BexioMCPServer-Setup-*.exe`.
3. Optionally load the image during setup (if Docker is already installed).
4. Start Menu → **Start Bexio MCP Server**.
5. Use MCP URL: `http://127.0.0.1:8000/mcp`.

## Notes

- NSIS cross-builds a **Windows PE** installer from Linux; that is supported.
- The embedded image is still a **linux/amd64** (or arm64) container image — not a Windows container.
- The installer does **not** install Docker Desktop; users must install it themselves.
- Large image archives make a large `.exe`; that is expected.
