import { createHash } from "node:crypto";

/** Verify S256 or plain PKCE */
export function verifyPkce(
  codeVerifier: string,
  challenge: string,
  method: string
): boolean {
  const m = (method || "S256").toUpperCase();
  if (m === "PLAIN") {
    return codeVerifier === challenge;
  }
  // S256
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return computed === challenge;
}
