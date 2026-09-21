/**
 * MCP OAuth 2.0 discovery helpers (RFC 9728 Protected Resource Metadata,
 * RFC 8414 Authorization Server Metadata).
 *
 * This server is a *resource server*: it does not run Bexio login itself.
 * It advertises Bexio's IdP so MCP clients (LibreChat, Claude, etc.) can
 * complete the authorization code flow and then call us with
 * Authorization: Bearer <bexio_access_token>.
 */

/** Default Bexio OpenID Connect issuer (Keycloak realm). */
export const DEFAULT_BEXIO_OAUTH_ISSUER =
  "https://auth.bexio.com/realms/bexio";

/** Sensible default scopes for a full-featured MCP integration. */
export const DEFAULT_BEXIO_OAUTH_SCOPES = [
  "accounting",
  "article_show",
  "article_edit",
  "bank_account_show",
  "bank_payment_show",
  "bank_payment_edit",
  "contact_show",
  "contact_edit",
  "file",
  "kb_invoice_show",
  "kb_invoice_edit",
  "kb_offer_show",
  "kb_offer_edit",
  "kb_order_show",
  "kb_order_edit",
  "kb_delivery_show",
  "kb_delivery_edit",
  "monitoring_show",
  "monitoring_edit",
  "note_show",
  "note_edit",
  "kb_article_order_show",
  "kb_article_order_edit",
  "project_show",
  "project_edit",
  "stock_edit",
  "task_show",
  "task_edit",
  "kb_bill_show",
  "kb_expense_show",
  "payroll_employee_show",
  "payroll_employee_edit",
  "payroll_absence_show",
  "payroll_absence_edit",
  "payroll_paystub_show",
  "openid",
  "profile",
  "email",
  "company_profile",
  "offline_access",
];

export interface OAuthDiscoveryConfig {
  /** Public base URL of this MCP server (no trailing slash), e.g. https://mcp.example.com */
  publicBaseUrl: string;
  /** Bexio OIDC issuer URL */
  issuer: string;
  /** Scopes advertised to clients */
  scopes: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
  resource_documentation?: string;
}

/**
 * Load discovery config from environment.
 * MCP_PUBLIC_URL is recommended when behind a reverse proxy.
 */
export function loadOAuthDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): {
  issuer: string;
  scopes: string[];
  publicBaseUrl: string | undefined;
} {
  const issuer = (
    env["BEXIO_OAUTH_ISSUER"] ?? DEFAULT_BEXIO_OAUTH_ISSUER
  ).replace(/\/$/, "");
  const scopesRaw = env["BEXIO_OAUTH_SCOPES"]?.trim();
  const scopes = scopesRaw
    ? scopesRaw.split(/[\s,]+/).filter(Boolean)
    : [...DEFAULT_BEXIO_OAUTH_SCOPES];
  const publicBaseUrl = env["MCP_PUBLIC_URL"]?.trim().replace(/\/$/, "") || undefined;
  return { issuer, scopes, publicBaseUrl };
}

/**
 * Resolve the public base URL for metadata from config or the incoming request.
 */
export function resolvePublicBaseUrl(
  configured: string | undefined,
  request: { protocol?: string; hostname?: string; headers: Record<string, unknown> }
): string {
  if (configured) return configured.replace(/\/$/, "");

  const xfProto = headerFirst(request.headers["x-forwarded-proto"]);
  const xfHost = headerFirst(request.headers["x-forwarded-host"]);
  const host =
    xfHost ||
    headerFirst(request.headers["host"]) ||
    request.hostname ||
    "localhost";
  const proto = xfProto || request.protocol || "http";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function headerFirst(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * RFC 9728 Protected Resource Metadata for this MCP resource.
 * @param resourcePath path of the MCP endpoint, e.g. "/mcp"
 */
export function buildProtectedResourceMetadata(
  config: OAuthDiscoveryConfig,
  resourcePath = "/mcp"
): ProtectedResourceMetadata {
  const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  return {
    resource: `${config.publicBaseUrl}${path}`,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: config.scopes,
    resource_documentation: "https://docs.bexio.com/#section/Authentication",
  };
}

/**
 * URL of the PRM document (for WWW-Authenticate resource_metadata=...).
 */
export function protectedResourceMetadataUrl(
  publicBaseUrl: string,
  resourcePath = "/mcp"
): string {
  const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  // Path-aware well-known URI (RFC 9728): /.well-known/oauth-protected-resource/mcp
  const suffix = path === "/" ? "" : path;
  return `${publicBaseUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource${suffix}`;
}

/**
 * WWW-Authenticate header value for a 401 challenge (RFC 6750 + RFC 9728).
 */
export function buildWwwAuthenticateHeader(
  publicBaseUrl: string,
  resourcePath = "/mcp"
): string {
  const metadataUrl = protectedResourceMetadataUrl(publicBaseUrl, resourcePath);
  return `Bearer realm="bexio-mcp", resource_metadata="${metadataUrl}"`;
}

/**
 * Static Authorization Server Metadata for Bexio (RFC 8414 shape).
 * Clients that probe *this* server's /.well-known/oauth-authorization-server
 * get Bexio's endpoints without an extra round-trip (legacy discovery).
 */
export function buildBexioAuthorizationServerMetadata(issuer: string): Record<string, unknown> {
  const base = issuer.replace(/\/$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/protocol/openid-connect/auth`,
    token_endpoint: `${base}/protocol/openid-connect/token`,
    userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`,
    jwks_uri: `${base}/protocol/openid-connect/certs`,
    revocation_endpoint: `${base}/protocol/openid-connect/revoke`,
    end_session_endpoint: `${base}/protocol/openid-connect/logout`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: [
      "openid",
      "profile",
      "email",
      "company_profile",
      "offline_access",
    ],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}
