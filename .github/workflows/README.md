# CI / Release workflows

## `build-and-release.yml`

| Event | Docker → GHCR | Windows `.exe` artifact | GitHub Release |
|-------|---------------|-------------------------|----------------|
| Pull request | Build only (no push) | Yes | No |
| Push `main` / `master` | Push `:latest` + `:0.0.0-ci.N` | Yes | No |
| Tag `v*` (e.g. `v0.1.0`) | Push `:latest`, `:0.1.0`, `:v0.1.0` | Yes | Yes (attaches installer) |
| workflow_dispatch | Push with optional version input | Yes | Only if run on a tag |

### Images

- `ghcr.io/<owner>/bexio-mcp-server:latest`
- `ghcr.io/<owner>/bexio-oauth-bridge:latest` — only if `bexio-oauth-bridge/Dockerfile` exists in the repo

### First-time GHCR

After the first successful push, open the package on GitHub and set visibility (private/public) if needed.

### Tag a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

Installer appears on the release page as `BexioMCPServer-Setup-0.1.0.exe`.
