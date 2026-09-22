function required(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

/** Public client_id advertised to Claude / MCP clients (no secret). */
export const PUBLIC_CLIENT_ID =
  process.env["OAUTH_PUBLIC_CLIENT_ID"]?.trim() || "bexio-mcp";

export const config = {
  port: Number(process.env["PORT"] ?? 3100),
  host: process.env["HOST"] ?? "0.0.0.0",
  publicBaseUrl: (
    process.env["PUBLIC_BASE_URL"] ?? "http://localhost:3100"
  ).replace(/\/$/, ""),

  bexio: {
    clientId: required("BEXIO_CLIENT_ID", process.env["BEXIO_CLIENT_ID"]),
    clientSecret: required(
      "BEXIO_CLIENT_SECRET",
      process.env["BEXIO_CLIENT_SECRET"]
    ),
    issuer: (
      process.env["BEXIO_OAUTH_ISSUER"] ??
      "https://auth.bexio.com/realms/bexio"
    ).replace(/\/$/, ""),
    /** Must be registered on the Bexio app — always THIS bridge */
    redirectUri: required(
      "BEXIO_REDIRECT_URI",
      process.env["BEXIO_REDIRECT_URI"]
    ),
    scopes: (
      process.env["BEXIO_SCOPES"] ??
      "openid profile email company_profile offline_access contact_edit kb_invoice_edit"
    )
      .split(/[\s,]+/)
      .filter(Boolean),
  },

  tokenEncryptionKey: required(
    "TOKEN_ENCRYPTION_KEY",
    process.env["TOKEN_ENCRYPTION_KEY"]
  ),

  databasePath: process.env["DATABASE_PATH"] ?? "./data/tokens.json",

  bridgeApiKey: process.env["BRIDGE_API_KEY"]?.trim() || undefined,

  /**
   * Comma-separated exact redirect URIs allowed for MCP clients (Claude).
   * Empty = allow common local/dev patterns only (see isRedirectUriAllowed).
   */
  allowedRedirectUris: (process.env["ALLOWED_REDIRECT_URIS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export function authorizeUrl(): string {
  return `${config.bexio.issuer}/protocol/openid-connect/auth`;
}

export function tokenUrl(): string {
  return `${config.bexio.issuer}/protocol/openid-connect/token`;
}

/**
 * Validate client redirect_uri. Production should set ALLOWED_REDIRECT_URIS
 * to Claude Desktop callback URLs once known.
 */
export function isRedirectUriAllowed(uri: string): boolean {
  if (config.allowedRedirectUris.length > 0) {
    return config.allowedRedirectUris.includes(uri);
  }
  // Dev-friendly defaults when allowlist is empty
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) {
      return true;
    }
    if (u.protocol === "https:") return true;
    // Custom schemes used by some desktop apps
    if (u.protocol === "cursor:" || u.protocol === "claude:" || u.protocol.endsWith(":")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
