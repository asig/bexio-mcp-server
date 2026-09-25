/**
 * Bexio OAuth Bridge — OAuth Authorization Server for MCP clients (Claude Desktop)
 *
 * Holds the global Bexio client_secret. Claude never sees it.
 *
 * Transparent flow (Option B):
 *  1. Claude discovers AS at /.well-known/oauth-authorization-server
 *  2. GET /oauth/authorize → redirect user to Bexio
 *  3. GET /oauth/bexio/callback → exchange code with Bexio (secret)
 *  4. Redirect to Claude with our one-time code
 *  5. POST /oauth/token → Claude gets Bexio access_token (+ our refresh_token)
 *  6. Claude sends Authorization: Bearer <access_token> to the MCP
 *
 * Legacy manual flow still available: /oauth/bexio/start → HTML + bridge token → GET /v1/token
 */

import Fastify from "fastify";
import {
  config,
  PUBLIC_CLIENT_ID,
  authorizeUrl,
  isRedirectUriAllowed,
} from "./config.js";
import { randomToken, pkceVerifier, pkceChallenge } from "./crypto.js";
import { verifyPkce } from "./pkce.js";
import { TokenStore } from "./store.js";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "./bexio-oauth.js";

const store = new TokenStore(config.databasePath, config.tokenEncryptionKey);
const app = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// Health + AS metadata (RFC 8414)
// ---------------------------------------------------------------------------

app.get("/health", async () => ({
  status: "ok",
  service: "bexio-oauth-bridge",
  mode: "oauth-authorization-server",
  issuer: config.publicBaseUrl,
  bexio_issuer: config.bexio.issuer,
  public_client_id: PUBLIC_CLIENT_ID,
}));

function authorizationServerMetadata() {
  const base = config.publicBaseUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    // "none" required for Claude public clients / CIMD / DCR without secret
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: config.bexio.scopes,
    subject_types_supported: ["public"],
    service_documentation: base,
    // Claude prefers CIMD when this is true; DCR is the fallback via registration_endpoint
    client_id_metadata_document_supported: true,
  };
}

app.get("/.well-known/oauth-authorization-server", async () =>
  authorizationServerMetadata()
);
app.get("/.well-known/openid-configuration", async () =>
  authorizationServerMetadata()
);

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591) — Claude "Register automatically"
// ---------------------------------------------------------------------------

app.post("/oauth/register", async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;

  const redirectUris = normalizeStringArray(body.redirect_uris);
  if (redirectUris.length === 0) {
    return reply.code(400).send({
      error: "invalid_client_metadata",
      error_description: "redirect_uris required",
    });
  }
  for (const uri of redirectUris) {
    if (!isRedirectUriAllowed(uri)) {
      return reply.code(400).send({
        error: "invalid_redirect_uri",
        error_description: `redirect_uri not allowed: ${uri}`,
      });
    }
  }

  const grantTypes = normalizeStringArray(body.grant_types);
  const responseTypes = normalizeStringArray(body.response_types);
  const tokenEndpointAuthMethod =
    typeof body.token_endpoint_auth_method === "string"
      ? body.token_endpoint_auth_method
      : "none";
  const clientName =
    typeof body.client_name === "string" ? body.client_name : undefined;
  const scope = typeof body.scope === "string" ? body.scope : undefined;

  const confidential =
    tokenEndpointAuthMethod !== "none" && tokenEndpointAuthMethod !== "";

  const { clientId, clientSecret, record } = store.registerClient({
    redirectUris,
    clientName,
    grantTypes: grantTypes.length ? grantTypes : undefined,
    responseTypes: responseTypes.length ? responseTypes : undefined,
    tokenEndpointAuthMethod,
    scope,
    confidential,
  });

  request.log.info({ clientId, redirectUris }, "DCR client registered");

  const response: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: record.clientIdIssuedAt,
    redirect_uris: record.redirectUris,
    grant_types: record.grantTypes,
    response_types: record.responseTypes,
    token_endpoint_auth_method: record.tokenEndpointAuthMethod,
  };
  if (clientName) response.client_name = clientName;
  if (scope) response.scope = scope;
  if (clientSecret) {
    response.client_secret = clientSecret;
    // No rotation policy — omit client_secret_expires_at (never expires)
  }

  return reply.code(201).send(response);
});

// ---------------------------------------------------------------------------
// OAuth authorize (Claude → us → Bexio)
// ---------------------------------------------------------------------------

app.get<{
  Querystring: {
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    state?: string;
    scope?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  };
}>("/oauth/authorize", async (request, reply) => {
  const q = request.query;

  if (q.response_type && q.response_type !== "code") {
    return oauthErrorRedirect(
      reply,
      q.redirect_uri,
      q.state,
      "unsupported_response_type",
      "Only response_type=code is supported"
    );
  }
  if (!q.redirect_uri) {
    return reply.code(400).send({ error: "invalid_request", error_description: "redirect_uri required" });
  }
  if (!q.code_challenge) {
    return oauthErrorRedirect(
      reply,
      q.redirect_uri,
      q.state,
      "invalid_request",
      "PKCE code_challenge required"
    );
  }

  const clientId = q.client_id || PUBLIC_CLIENT_ID;

  // Validate client + redirect_uri:
  // 1) Static public client (bexio-mcp)
  // 2) DCR-registered client
  // 3) CIMD: client_id is an https URL (Claude published identity) — fetch & check redirect
  const clientOk = await validateOAuthClient(clientId, q.redirect_uri, request.log);
  if (!clientOk.ok) {
    return reply.code(400).send({
      error: "invalid_client",
      error_description: clientOk.error,
      redirect_uri: q.redirect_uri,
    });
  }

  const state = randomToken(24);
  const bexioVerifier = pkceVerifier();
  const bexioChallenge = pkceChallenge(bexioVerifier);

  store.saveClientPending(state, {
    bexioCodeVerifier: bexioVerifier,
    clientRedirectUri: q.redirect_uri,
    clientState: q.state ?? "",
    clientCodeChallenge: q.code_challenge,
    clientCodeChallengeMethod: q.code_challenge_method || "S256",
    clientId,
    scope: q.scope || config.bexio.scopes.join(" "),
  });

  const url = new URL(authorizeUrl());
  url.searchParams.set("client_id", config.bexio.clientId);
  url.searchParams.set("redirect_uri", config.bexio.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.bexio.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", bexioChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return reply.redirect(url.toString());
});

// ---------------------------------------------------------------------------
// Bexio callback (only URI registered on the global Bexio app)
// ---------------------------------------------------------------------------

app.get<{
  Querystring: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  };
}>("/oauth/bexio/callback", async (request, reply) => {
  const { code, state, error, error_description } = request.query;

  if (!state) {
    return reply.code(400).type("text/html").send(errorPage("Missing state"));
  }

  const pending = store.takePending(state);
  if (!pending) {
    return reply
      .code(400)
      .type("text/html")
      .send(errorPage("Invalid or expired state"));
  }

  // --- Client (Claude) flow ---
  if (pending.kind === "client") {
    if (error) {
      return oauthErrorRedirect(
        reply,
        pending.clientRedirectUri,
        pending.clientState,
        error,
        error_description
      );
    }
    if (!code) {
      return oauthErrorRedirect(
        reply,
        pending.clientRedirectUri,
        pending.clientState,
        "server_error",
        "Missing code from Bexio"
      );
    }
    try {
      const tokens = await exchangeAuthorizationCode(
        code,
        pending.bexioCodeVerifier
      );
      const authCode = store.createAuthCode(tokens, {
        clientRedirectUri: pending.clientRedirectUri,
        clientCodeChallenge: pending.clientCodeChallenge,
        clientCodeChallengeMethod: pending.clientCodeChallengeMethod,
        clientId: pending.clientId,
      });
      const dest = new URL(pending.clientRedirectUri);
      dest.searchParams.set("code", authCode);
      if (pending.clientState) dest.searchParams.set("state", pending.clientState);
      return reply.redirect(dest.toString());
    } catch (err) {
      request.log.error(err);
      return oauthErrorRedirect(
        reply,
        pending.clientRedirectUri,
        pending.clientState,
        "server_error",
        err instanceof Error ? err.message : "Token exchange failed"
      );
    }
  }

  // --- Manual HTML flow ---
  if (error) {
    return reply
      .code(400)
      .type("text/html")
      .send(errorPage(`Bexio error: ${error}`, error_description));
  }
  if (!code) {
    return reply.code(400).type("text/html").send(errorPage("Missing code"));
  }
  try {
    const tokens = await exchangeAuthorizationCode(code, pending.codeVerifier);
    const { sessionId, bridgeToken } = store.createSessionAsBridgeToken(
      tokens,
      pending.label
    );
    return reply.type("text/html").send(
      successPage({ sessionId, bridgeToken })
    );
  } catch (err) {
    request.log.error(err);
    return reply
      .code(500)
      .type("text/html")
      .send(
        errorPage(
          "Token exchange failed",
          err instanceof Error ? err.message : String(err)
        )
      );
  }
});

// ---------------------------------------------------------------------------
// Token endpoint (Claude exchanges code / refreshes)
// ---------------------------------------------------------------------------

app.post("/oauth/token", async (request, reply) => {
  const body = normalizeFormBody(request.body);

  if (body.grant_type === "authorization_code") {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const codeVerifier = body.code_verifier;
    if (!code || !redirectUri || !codeVerifier) {
      return reply.code(400).send({
        error: "invalid_request",
        error_description: "code, redirect_uri, and code_verifier required",
      });
    }
    const record = store.takeAuthCode(code);
    if (!record) {
      return reply.code(400).send({ error: "invalid_grant", error_description: "Invalid or expired code" });
    }
    if (record.clientRedirectUri !== redirectUri) {
      return reply.code(400).send({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    }
    if (
      !verifyPkce(
        codeVerifier,
        record.clientCodeChallenge,
        record.clientCodeChallengeMethod
      )
    ) {
      return reply.code(400).send({ error: "invalid_grant", error_description: "PKCE verification failed" });
    }

    const { refreshToken } = store.createSession(record.tokens);
    const expiresIn = Math.max(
      60,
      Math.floor((record.tokens.expiresAt - Date.now()) / 1000)
    );

    return {
      access_token: record.tokens.accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: record.tokens.scope,
    };
  }

  if (body.grant_type === "refresh_token") {
    const refreshToken = body.refresh_token;
    if (!refreshToken) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const session = store.getByRefreshToken(refreshToken);
    if (!session) {
      return reply.code(400).send({ error: "invalid_grant" });
    }
    let tokens = session.tokens;
    if (Date.now() >= tokens.expiresAt - 60_000) {
      if (!tokens.refreshToken) {
        return reply.code(400).send({
          error: "invalid_grant",
          error_description: "Bexio refresh_token missing; re-authorize",
        });
      }
      try {
        tokens = await refreshAccessToken(tokens.refreshToken);
        store.updateTokens(session.sessionId, tokens);
      } catch (err) {
        request.log.error(err);
        return reply.code(400).send({
          error: "invalid_grant",
          error_description:
            err instanceof Error ? err.message : "Refresh failed",
        });
      }
    }
    const expiresIn = Math.max(
      60,
      Math.floor((tokens.expiresAt - Date.now()) / 1000)
    );
    return {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: tokens.scope,
    };
  }

  return reply.code(400).send({
    error: "unsupported_grant_type",
    error_description: "Use authorization_code or refresh_token",
  });
});

app.post("/oauth/revoke", async (request, reply) => {
  const body = normalizeFormBody(request.body);
  const token = body.token;
  if (token) store.deleteByRefreshToken(token);
  return reply.code(200).send({});
});

// ---------------------------------------------------------------------------
// Legacy manual helpers
// ---------------------------------------------------------------------------

app.get<{ Querystring: { label?: string } }>(
  "/oauth/bexio/start",
  async (request, reply) => {
    const state = randomToken(24);
    const verifier = pkceVerifier();
    store.saveManualPending(state, verifier, request.query.label);

    const url = new URL(authorizeUrl());
    url.searchParams.set("client_id", config.bexio.clientId);
    url.searchParams.set("redirect_uri", config.bexio.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.bexio.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return reply.redirect(url.toString());
  }
);

app.get("/v1/token", async (request, reply) => {
  if (config.bridgeApiKey) {
    if (request.headers["x-api-key"] !== config.bridgeApiKey) {
      return reply.code(401).send({ error: "invalid_api_key" });
    }
  }
  const auth = request.headers.authorization;
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const session = store.getByBridgeToken(auth.slice(7).trim());
  if (!session) {
    return reply.code(401).send({ error: "invalid_bridge_token" });
  }
  let tokens = session.tokens;
  if (Date.now() >= tokens.expiresAt) {
    if (!tokens.refreshToken) {
      return reply.code(401).send({ error: "token_expired" });
    }
    try {
      tokens = await refreshAccessToken(tokens.refreshToken);
      store.updateTokens(session.sessionId, tokens);
    } catch (err) {
      request.log.error(err);
      return reply.code(401).send({ error: "refresh_failed" });
    }
  }
  return {
    token_type: "Bearer",
    access_token: tokens.accessToken,
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
    session_id: session.sessionId,
  };
});

app.delete("/v1/session", async (request, reply) => {
  const auth = request.headers.authorization;
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return { revoked: store.deleteByBridgeToken(auth.slice(7).trim()) };
});

app.get("/", async (_request, reply) => {
  return reply.type("text/html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Bexio OAuth Bridge</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
 code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px}
</style></head><body>
<h1>Bexio OAuth Bridge</h1>
<p>OAuth authorization server for MCP clients (e.g. Claude Desktop). The Bexio client secret stays on this server.</p>
<ul>
<li><a href="/.well-known/oauth-authorization-server">AS metadata</a></li>
<li>Authorize: <code>/oauth/authorize</code></li>
<li>Token: <code>/oauth/token</code></li>
<li>DCR register: <code>POST /oauth/register</code></li>
<li>Public client_id: <code>${PUBLIC_CLIENT_ID}</code></li>
<li>CIMD + DCR supported (Claude &quot;published identity&quot; / &quot;register automatically&quot;)</li>
</ul>
<p>MCP should advertise this host as <code>authorization_servers</code> (set <code>BEXIO_OAUTH_ISSUER</code> / public URL on the MCP to <code>${config.publicBaseUrl}</code>).</p>
<p>Manual connect (legacy): <a href="/oauth/bexio/start">/oauth/bexio/start</a></p>
</body></html>`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFormBody(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return out;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Accept:
 * - static PUBLIC_CLIENT_ID + global redirect allowlist
 * - DCR clients (redirect must match registration)
 * - CIMD: client_id is https URL → fetch document, match redirect_uris
 */
async function validateOAuthClient(
  clientId: string,
  redirectUri: string,
  log: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
): Promise<{ ok: true } | { ok: false; error: string }> {
  // 1) Built-in public client
  if (clientId === PUBLIC_CLIENT_ID) {
    if (!isRedirectUriAllowed(redirectUri)) {
      return {
        ok: false,
        error:
          "redirect_uri not allowed for public client. Set ALLOWED_REDIRECT_URIS or use DCR.",
      };
    }
    return { ok: true };
  }

  // 2) DCR-registered client
  const registered = store.getClient(clientId);
  if (registered) {
    if (!registered.redirectUris.includes(redirectUri)) {
      return { ok: false, error: "redirect_uri not registered for this client" };
    }
    return { ok: true };
  }

  // 3) CIMD — client_id is a metadata document URL
  if (clientId.startsWith("https://")) {
    try {
      const res = await fetch(clientId, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `CIMD fetch failed (${res.status}) for client_id URL`,
        };
      }
      const doc = (await res.json()) as {
        client_id?: string;
        redirect_uris?: string[];
      };
      if (doc.client_id && doc.client_id !== clientId) {
        return {
          ok: false,
          error: "CIMD client_id field does not match document URL",
        };
      }
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
      if (!uris.includes(redirectUri)) {
        return {
          ok: false,
          error: "redirect_uri not listed in Claude CIMD document",
        };
      }
      // Also respect global allowlist when set
      if (
        config.allowedRedirectUris.length > 0 &&
        !config.allowedRedirectUris.includes(redirectUri)
      ) {
        return {
          ok: false,
          error: "redirect_uri blocked by ALLOWED_REDIRECT_URIS",
        };
      }
      return { ok: true };
    } catch (err) {
      log.error(err, "CIMD fetch error");
      return {
        ok: false,
        error: err instanceof Error ? err.message : "CIMD fetch failed",
      };
    }
  }

  return { ok: false, error: `Unknown client_id: ${clientId}` };
}

function oauthErrorRedirect(
  reply: { redirect: (url: string) => unknown },
  redirectUri: string | undefined,
  state: string | undefined,
  error: string,
  description?: string
) {
  if (!redirectUri) {
    return reply.redirect(
      `${config.publicBaseUrl}/?error=${encodeURIComponent(error)}`
    );
  }
  try {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (description) u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return reply.redirect(u.toString());
  } catch {
    return reply.redirect(`${config.publicBaseUrl}/?error=${error}`);
  }
}

function successPage(opts: { sessionId: string; bridgeToken: string }): string {
  const tokenJson = JSON.stringify(opts.bridgeToken);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Connected</title>
<style>body{font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}
.token{word-break:break-all;background:#f4f4f4;padding:.75rem;border-radius:6px;font-family:monospace;font-size:.85rem}
.warn{background:#fff8e6;padding:.75rem;border-radius:6px}</style></head><body>
<h1>Bexio connected</h1>
<p class="warn">Legacy bridge token (for /v1/token). Claude Desktop should use the OAuth authorize/token flow instead.</p>
<p class="token" id="bridge">${escapeHtml(opts.bridgeToken)}</p>
<p><button type="button" onclick='navigator.clipboard.writeText(${tokenJson})'>Copy</button></p>
</body></html>`;
}

function errorPage(title: string, detail?: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:40rem;margin:2rem auto">
<h1>${escapeHtml(title)}</h1>${detail ? `<pre>${escapeHtml(detail)}</pre>` : ""}
<p><a href="/">Home</a></p></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// application/x-www-form-urlencoded for token endpoint
app.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_req, body, done) => {
    try {
      const out: Record<string, string> = {};
      for (const part of String(body).split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const k = eq === -1 ? part : part.slice(0, eq);
        const v = eq === -1 ? "" : part.slice(eq + 1);
        if (k) {
          out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(
            v.replace(/\+/g, " ")
          );
        }
      }
      done(null, out);
    } catch (e) {
      done(e as Error, undefined);
    }
  }
);

await app.listen({ port: config.port, host: config.host });
console.error(
  `bexio-oauth-bridge AS listening on ${config.host}:${config.port} issuer=${config.publicBaseUrl}`
);
