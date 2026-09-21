import { config, tokenUrl } from "./config.js";
import type { TokenBundle } from "./store.js";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export function toBundle(tr: TokenResponse): TokenBundle {
  const expiresIn = tr.expires_in ?? 300;
  return {
    accessToken: tr.access_token,
    refreshToken: tr.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000 - 30_000, // 30s skew
    scope: tr.scope,
    tokenType: tr.token_type ?? "Bearer",
  };
}

export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string
): Promise<TokenBundle> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.bexio.redirectUri,
    client_id: config.bexio.clientId,
    client_secret: config.bexio.clientSecret,
    code_verifier: codeVerifier,
  });

  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as TokenResponse;
  return toBundle(json);
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<TokenBundle> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.bexio.clientId,
    client_secret: config.bexio.clientSecret,
  });

  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as TokenResponse;
  // Bexio may omit refresh_token on refresh — keep old one
  const bundle = toBundle(json);
  if (!bundle.refreshToken) {
    bundle.refreshToken = refreshToken;
  }
  return bundle;
}
