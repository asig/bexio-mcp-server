/**
 * Bexio OAuth Bridge
 *
 * Holds the global Bexio app client_secret, runs authorization code + PKCE,
 * stores encrypted tokens, and returns Bexio access tokens for MCP clients.
 *
 * Flow:
 *  1. GET  /oauth/bexio/start          → redirect to Bexio
 *  2. GET  /oauth/bexio/callback       → exchange code, show bridge token once
 *  3. GET  /v1/token                   → Authorization: Bearer <bridge_token>
 *                                       → { access_token, expires_at, token_type }
 *  4. Use access_token as Authorization on the MCP server
 */

import Fastify from "fastify";
import { config, authorizeUrl } from "./config.js";
import { randomToken, pkceVerifier, pkceChallenge } from "./crypto.js";
import { TokenStore } from "./store.js";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "./bexio-oauth.js";

const store = new TokenStore(config.databasePath, config.tokenEncryptionKey);

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok",
  service: "bexio-oauth-bridge",
  issuer: config.bexio.issuer,
}));

/** Start OAuth — optional ?label= for display name */
app.get<{ Querystring: { label?: string } }>(
  "/oauth/bexio/start",
  async (request, reply) => {
    const state = randomToken(24);
    const verifier = pkceVerifier();
    const challenge = pkceChallenge(verifier);
    store.savePending(state, verifier, request.query.label);

    const url = new URL(authorizeUrl());
    url.searchParams.set("client_id", config.bexio.clientId);
    url.searchParams.set("redirect_uri", config.bexio.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.bexio.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    return reply.redirect(url.toString());
  }
);

app.get<{
  Querystring: { code?: string; state?: string; error?: string; error_description?: string };
}>("/oauth/bexio/callback", async (request, reply) => {
  const { code, state, error, error_description } = request.query;

  if (error) {
    return reply
      .code(400)
      .type("text/html")
      .send(errorPage(`Bexio returned an error: ${error}`, error_description));
  }
  if (!code || !state) {
    return reply
      .code(400)
      .type("text/html")
      .send(errorPage("Missing code or state"));
  }

  const pending = store.takePending(state);
  if (!pending) {
    return reply
      .code(400)
      .type("text/html")
      .send(errorPage("Invalid or expired state. Start again from /oauth/bexio/start"));
  }

  try {
    const tokens = await exchangeAuthorizationCode(code, pending.codeVerifier);
    const { sessionId, bridgeToken } = store.createSession(
      tokens,
      pending.label
    );

    return reply.type("text/html").send(
      successPage({
        sessionId,
        bridgeToken,
        mcpHint:
          "Use the Bexio access_token from GET /v1/token as Authorization: Bearer on your MCP server.",
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    request.log.error(err);
    return reply.code(500).type("text/html").send(errorPage("Token exchange failed", msg));
  }
});

/**
 * Resolve a current Bexio access token from a bridge token.
 * Header: Authorization: Bearer <bridge_token>
 * Optional: X-API-Key: <BRIDGE_API_KEY> if configured
 */
app.get("/v1/token", async (request, reply) => {
  if (config.bridgeApiKey) {
    const key = request.headers["x-api-key"];
    if (key !== config.bridgeApiKey) {
      return reply.code(401).send({ error: "invalid_api_key" });
    }
  }

  const auth = request.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return reply.code(401).send({
      error: "unauthorized",
      error_description: "Send Authorization: Bearer <bridge_token>",
    });
  }
  const bridgeToken = auth.slice(7).trim();
  const session = store.getByBridgeToken(bridgeToken);
  if (!session) {
    return reply.code(401).send({ error: "invalid_bridge_token" });
  }

  let tokens = session.tokens;
  if (Date.now() >= tokens.expiresAt) {
    if (!tokens.refreshToken) {
      return reply.code(401).send({
        error: "token_expired",
        error_description: "Access token expired and no refresh_token. Re-authorize.",
      });
    }
    try {
      tokens = await refreshAccessToken(tokens.refreshToken);
      store.updateTokens(session.sessionId, tokens);
    } catch (err) {
      request.log.error(err);
      return reply.code(401).send({
        error: "refresh_failed",
        error_description:
          err instanceof Error ? err.message : "Could not refresh token",
      });
    }
  }

  return {
    token_type: "Bearer",
    access_token: tokens.accessToken,
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
    session_id: session.sessionId,
    label: session.label,
  };
});

/** Revoke local session (does not call Bexio revoke). */
app.delete("/v1/session", async (request, reply) => {
  const auth = request.headers.authorization;
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const ok = store.deleteByBridgeToken(auth.slice(7).trim());
  return { revoked: ok };
});

app.get("/", async (_request, reply) => {
  return reply.type("text/html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Bexio OAuth Bridge</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  a.button { display: inline-block; background: #0b5fff; color: #fff; padding: 0.6rem 1rem; border-radius: 6px; text-decoration: none; }
  code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style></head><body>
  <h1>Bexio OAuth Bridge</h1>
  <p>Connect a Bexio account for use with the MCP server. The client secret stays on this server.</p>
  <p><a class="button" href="/oauth/bexio/start">Connect with Bexio</a></p>
  <h2>After connecting</h2>
  <ol>
    <li>Copy the <strong>bridge token</strong> shown once on the success page.</li>
    <li><code>GET /v1/token</code> with <code>Authorization: Bearer &lt;bridge_token&gt;</code></li>
    <li>Use the returned <code>access_token</code> as <code>Authorization: Bearer</code> on the MCP (<code>/mcp</code>).</li>
  </ol>
  <p>Health: <a href="/health">/health</a></p>
</body></html>`);
});

function successPage(opts: {
  sessionId: string;
  bridgeToken: string;
  mcpHint: string;
}): string {
  const tokenJson = JSON.stringify(opts.bridgeToken);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Connected</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  .token { word-break: break-all; background: #f4f4f4; padding: 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.85rem; }
  .warn { color: #8a5a00; background: #fff8e6; padding: 0.75rem; border-radius: 6px; }
</style></head><body>
  <h1>Bexio connected</h1>
  <p class="warn">Copy the bridge token now. It is shown only once and cannot be retrieved again.</p>
  <p><strong>Session ID</strong></p>
  <p class="token">${escapeHtml(opts.sessionId)}</p>
  <p><strong>Bridge token</strong></p>
  <p class="token" id="bridge">${escapeHtml(opts.bridgeToken)}</p>
  <p><button type="button" onclick="navigator.clipboard.writeText(${tokenJson})">Copy bridge token</button></p>
  <h2>Get a Bexio access token</h2>
  <pre>curl -s ${escapeHtml(config.publicBaseUrl)}/v1/token \\
  -H "Authorization: Bearer YOUR_BRIDGE_TOKEN"</pre>
  <p>${escapeHtml(opts.mcpHint)}</p>
  <p><a href="/">Home</a></p>
</body></html>`;
}

function errorPage(title: string, detail?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Error</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
  <h1>${escapeHtml(title)}</h1>
  ${detail ? `<pre>${escapeHtml(detail)}</pre>` : ""}
  <p><a href="/oauth/bexio/start">Try again</a></p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

await app.listen({ port: config.port, host: config.host });
console.error(
  `bexio-oauth-bridge listening on ${config.host}:${config.port} (public ${config.publicBaseUrl})`
);
