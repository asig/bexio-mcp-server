function required(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

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

  /** 64 hex chars = 32 bytes */
  tokenEncryptionKey: required(
    "TOKEN_ENCRYPTION_KEY",
    process.env["TOKEN_ENCRYPTION_KEY"]
  ),

  databasePath: process.env["DATABASE_PATH"] ?? "./data/tokens.json",

  /** Optional shared secret for machine clients calling /v1/token */
  bridgeApiKey: process.env["BRIDGE_API_KEY"]?.trim() || undefined,
};

export function authorizeUrl(): string {
  return `${config.bexio.issuer}/protocol/openid-connect/auth`;
}

export function tokenUrl(): string {
  return `${config.bexio.issuer}/protocol/openid-connect/token`;
}
