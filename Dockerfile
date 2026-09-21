# syntax=docker/dockerfile:1
#
# Bexio MCP Server (with per-request Bearer token support)
#
# Build (from this directory):
#   docker build -t bexio-mcp-server:bearer .
#
# Run HTTP mode (token via header preferred; env is optional fallback):
#   docker run --rm -p 8000:8000 bexio-mcp-server:bearer
#
# Run HTTP with env fallback token:
#   docker run --rm -p 8000:8000 -e BEXIO_API_TOKEN=your-token bexio-mcp-server:bearer
#
# Call with Bearer token:
#   curl -s -X POST http://localhost:8000/tools/call \
#     -H "Authorization: Bearer YOUR_BEXIO_TOKEN" \
#     -H "Content-Type: application/json" \
#     -d '{"name":"ping","arguments":{}}'

# ---- build stage ----
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Install dependencies first (better layer caching)
COPY src/package.json src/package-lock.json ./
RUN npm ci

# Copy sources and build (tests excluded by tsconfig)
COPY src/ ./
# Skip UI vite build in container — not required for HTTP/stdio API tools
ENV BEXIO_ENABLE_UI=false
RUN npx tsc && \
    node -e "require('fs').writeFileSync('dist/package.json', JSON.stringify({type:'module'}, null, 2)+'\n')"

# Production node_modules only
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="bexio-mcp-server"
LABEL org.opencontainers.image.description="Bexio MCP server with per-request Bearer token support"
LABEL org.opencontainers.image.source="https://github.com/asig/bexio-mcp-server"

WORKDIR /app

ENV NODE_ENV=production
# Default to HTTP so the container is useful without a stdio client attached
ENV MCP_MODE=http
ENV PORT=8000
ENV HOST=0.0.0.0

# Non-root user
RUN groupadd --gid 1001 mcp && \
    useradd --uid 1001 --gid mcp --shell /bin/false --create-home mcp

COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/package.json ./

USER mcp

EXPOSE 8000

# Healthcheck hits the HTTP root endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# index.js parses --mode / --port / --host from argv
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--mode", "http", "--host", "0.0.0.0", "--port", "8000"]
