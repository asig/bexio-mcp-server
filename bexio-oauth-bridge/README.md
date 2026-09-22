# Bexio OAuth Bridge

Small service for a **global** Bexio OAuth app:

- Holds `BEXIO_CLIENT_ID` / `BEXIO_CLIENT_SECRET` (never ship these to Claude Desktop)
- Authorization code flow + **PKCE** against Bexio
- Stores access/refresh tokens encrypted in JSON file
- Issues current Bexio **access tokens** via `GET /v1/token` using a one-time **bridge token**

The MCP server stays a pure Bearer forwarder.

## Flow

```text
Browser  →  GET /oauth/bexio/start  →  Bexio login
         ←  callback with code
Bridge   →  token exchange (client secret)
User     ←  bridge token (shown once)
Client   →  GET /v1/token  (Authorization: Bearer <bridge_token>)
         ←  { access_token }
MCP      ←  Authorization: Bearer <access_token>
```

## Setup

1. Create a Bexio app at [developer.bexio.com](https://developer.bexio.com/)
2. Set redirect URI to:  
   `https://YOUR_HOST/oauth/bexio/callback`  
   (local: `http://localhost:3100/oauth/bexio/callback`)
3. Copy `.env.example` → `.env` and fill values:

```bash
openssl rand -hex 32   # → TOKEN_ENCRYPTION_KEY
```

4. Run:

```bash
npm install
npm run build
npm start
# or: npx tsx src/index.ts
```

Docker:

```bash
docker build -t bexio-oauth-bridge .
docker run --rm -p 3100:3100 --env-file .env \
  -v bridge-data:/app/data bexio-oauth-bridge
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Simple connect UI |
| GET | `/oauth/bexio/start` | Start OAuth (optional `?label=`) |
| GET | `/oauth/bexio/callback` | OAuth redirect target |
| GET | `/v1/token` | `Authorization: Bearer <bridge_token>` → Bexio access token |
| DELETE | `/v1/session` | Drop local session |
| GET | `/health` | Liveness |

Optional: set `BRIDGE_API_KEY` and send `X-API-Key` on `/v1/token`.

### Example

```bash
# After connecting in the browser and copying the bridge token:
curl -s http://localhost:3100/v1/token \
  -H "Authorization: Bearer BRIDGE_TOKEN_HERE" | jq .

# Use access_token on MCP:
curl -s -X POST http://127.0.0.1:8000/mcp \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Claude Desktop / customers

- **Do not** put `BEXIO_CLIENT_SECRET` in Claude config.
- Customers open your bridge URL, connect Bexio, keep the **bridge token** private.
- A thin helper or your product backend calls `/v1/token` and passes `access_token` to the MCP.
- For fully automated Claude setups, host the MCP yourself and attach tokens server-side after the user connects via this bridge.


## Makefile / Docker

```bash
cp .env.example .env   # fill secrets
make build
make run-env           # --env-file .env -p 3100 -v data

# Publish
export GHCR_TOKEN=ghp_...
make release GHCR_USER=youruser
```

Image: `bexio-oauth-bridge:latest` (or `ghcr.io/<user>/bexio-oauth-bridge:latest`)


## Production (Docker Compose)

On the prod host:

```bash
git clone <this-repo> && cd bexio-oauth-bridge   # or copy the folder
cp .env.example .env
# Edit .env — required:
#   BEXIO_CLIENT_ID=
#   BEXIO_CLIENT_SECRET=
#   TOKEN_ENCRYPTION_KEY=   # openssl rand -hex 32
#   PUBLIC_BASE_URL=https://auth.yourdomain.com
#   BEXIO_REDIRECT_URI=https://auth.yourdomain.com/oauth/bexio/callback

docker compose up -d --build
docker compose ps
curl -s https://auth.yourdomain.com/health   # via your reverse proxy
```

Register the same redirect URI on the global Bexio app at developer.bexio.com.

TLS: terminate HTTPS on Caddy/nginx/Traefik and proxy to `127.0.0.1:3100` (or the compose service on a shared Docker network). See `docker-compose.prod.example.yml` for a no-published-port layout.

```bash
docker compose logs -f bexio-oauth-bridge
docker compose pull   # if using a pre-built image
docker compose up -d
```

## Security notes

- Deploy over **HTTPS** in production (`PUBLIC_BASE_URL`, redirect URI).
- `TOKEN_ENCRYPTION_KEY` loss = cannot decrypt stored tokens (users must reconnect).
- Bridge tokens are bearer secrets; treat like passwords.
- Rotate the global Bexio client secret in the developer portal if leaked.
