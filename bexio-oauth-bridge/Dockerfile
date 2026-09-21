# syntax=docker/dockerfile:1
# Bexio OAuth Bridge — holds global client secret, issues access tokens for MCP
#
#   docker build -t bexio-oauth-bridge:latest .
#   docker run --rm -p 3100:3100 --env-file .env -v bridge-data:/app/data bexio-oauth-bridge:latest

# ---- Build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc && npm prune --omit=dev

# ---- Runtime ----
FROM node:20-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="bexio-oauth-bridge"
LABEL org.opencontainers.image.description="Global Bexio OAuth bridge for MCP (client secret stays server-side)"
LABEL org.opencontainers.image.source="https://github.com/asig/bexio-mcp-server"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3100 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/tokens.json

RUN groupadd --gid 1001 bridge && \
    useradd --uid 1001 --gid bridge --shell /bin/false --create-home bridge && \
    mkdir -p /app/data && \
    chown -R bridge:bridge /app

COPY --from=build --chown=bridge:bridge /app/node_modules ./node_modules
COPY --from=build --chown=bridge:bridge /app/dist ./dist
COPY --from=build --chown=bridge:bridge /app/package.json ./

USER bridge
VOLUME ["/app/data"]
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
