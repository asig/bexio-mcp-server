/**
 * Parse an HTTP Authorization header value for a Bearer token.
 * Accepts "Bearer <token>" (case-insensitive scheme). Returns undefined if
 * absent or not a Bearer credential.
 */
export function parseBearerAuthorization(
  authorization: string | string[] | undefined
): string | undefined {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!raw || typeof raw !== "string") return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  if (!match) return undefined;
  const token = match[1]?.trim();
  return token || undefined;
}
