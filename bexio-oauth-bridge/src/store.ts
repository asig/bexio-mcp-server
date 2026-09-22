import fs from "node:fs";
import path from "node:path";
import { encrypt, decrypt, randomToken, sha256 } from "./crypto.js";

export interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

/** Manual HTML flow (legacy) */
interface ManualPending {
  kind: "manual";
  codeVerifier: string;
  label: string | null;
  createdAt: number;
}

/** Claude / MCP client OAuth authorize request */
export interface ClientAuthPending {
  kind: "client";
  /** PKCE verifier we use with Bexio */
  bexioCodeVerifier: string;
  /** Claude's redirect_uri */
  clientRedirectUri: string;
  /** Claude's state (returned unchanged) */
  clientState: string;
  /** Claude's PKCE challenge */
  clientCodeChallenge: string;
  clientCodeChallengeMethod: string;
  clientId: string;
  scope: string;
  createdAt: number;
}

type Pending = ManualPending | ClientAuthPending;

interface AuthCodeRecord {
  clientRedirectUri: string;
  clientCodeChallenge: string;
  clientCodeChallengeMethod: string;
  clientId: string;
  encryptedTokens: string;
  createdAt: number;
}

interface Session {
  id: string;
  /** hash of bridge refresh token OR legacy bridge token */
  tokenHash: string;
  label: string | null;
  encryptedTokens: string;
  createdAt: number;
  updatedAt: number;
}

interface DbFile {
  pending: Record<string, Pending>;
  authCodes: Record<string, AuthCodeRecord>;
  sessions: Record<string, Session>;
}

export class TokenStore {
  private filePath: string;
  private keyHex: string;
  private data: DbFile;

  constructor(dbPath: string, keyHex: string) {
    this.filePath = path.resolve(dbPath);
    this.keyHex = keyHex;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.load();
  }

  private load(): DbFile {
    if (!fs.existsSync(this.filePath)) {
      return { pending: {}, authCodes: {}, sessions: {} };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<DbFile>;
      return {
        pending: raw.pending ?? {},
        authCodes: raw.authCodes ?? {},
        sessions: raw.sessions ?? {},
      };
    } catch {
      return { pending: {}, authCodes: {}, sessions: {} };
    }
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  // ---- pending (state) ----

  saveManualPending(state: string, codeVerifier: string, label?: string): void {
    this.data.pending[state] = {
      kind: "manual",
      codeVerifier,
      label: label ?? null,
      createdAt: Date.now(),
    };
    this.save();
  }

  saveClientPending(state: string, pending: Omit<ClientAuthPending, "kind" | "createdAt">): void {
    this.data.pending[state] = {
      kind: "client",
      ...pending,
      createdAt: Date.now(),
    };
    this.save();
  }

  takePending(state: string): Pending | undefined {
    const row = this.data.pending[state];
    if (!row) return undefined;
    delete this.data.pending[state];
    this.save();
    return row;
  }

  // ---- one-time auth codes (for Claude token exchange) ----

  createAuthCode(
    tokens: TokenBundle,
    meta: {
      clientRedirectUri: string;
      clientCodeChallenge: string;
      clientCodeChallengeMethod: string;
      clientId: string;
    }
  ): string {
    const code = randomToken(32);
    this.data.authCodes[code] = {
      ...meta,
      encryptedTokens: encrypt(JSON.stringify(tokens), this.keyHex),
      createdAt: Date.now(),
    };
    this.save();
    return code;
  }

  takeAuthCode(code: string): (AuthCodeRecord & { tokens: TokenBundle }) | undefined {
    const row = this.data.authCodes[code];
    if (!row) return undefined;
    // 10 minute expiry
    if (Date.now() - row.createdAt > 10 * 60 * 1000) {
      delete this.data.authCodes[code];
      this.save();
      return undefined;
    }
    delete this.data.authCodes[code];
    this.save();
    const tokens = JSON.parse(decrypt(row.encryptedTokens, this.keyHex)) as TokenBundle;
    return { ...row, tokens };
  }

  // ---- sessions (refresh / legacy bridge token) ----

  createSession(
    tokens: TokenBundle,
    label?: string | null
  ): { sessionId: string; refreshToken: string } {
    const sessionId = randomToken(16);
    const refreshToken = randomToken(32);
    const now = Date.now();
    this.data.sessions[sessionId] = {
      id: sessionId,
      tokenHash: sha256(refreshToken),
      label: label ?? null,
      encryptedTokens: encrypt(JSON.stringify(tokens), this.keyHex),
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    return { sessionId, refreshToken };
  }

  /** Alias used by legacy HTML flow (bridge token == refresh token) */
  createSessionAsBridgeToken(
    tokens: TokenBundle,
    label?: string | null
  ): { sessionId: string; bridgeToken: string } {
    const { sessionId, refreshToken } = this.createSession(tokens, label);
    return { sessionId, bridgeToken: refreshToken };
  }

  getByRefreshToken(refreshToken: string): {
    sessionId: string;
    label: string | null;
    tokens: TokenBundle;
  } | undefined {
    const hash = sha256(refreshToken);
    const session = Object.values(this.data.sessions).find((s) => s.tokenHash === hash);
    if (!session) return undefined;
    const tokens = JSON.parse(
      decrypt(session.encryptedTokens, this.keyHex)
    ) as TokenBundle;
    return { sessionId: session.id, label: session.label, tokens };
  }

  getByBridgeToken(bridgeToken: string) {
    return this.getByRefreshToken(bridgeToken);
  }

  updateTokens(sessionId: string, tokens: TokenBundle): void {
    const session = this.data.sessions[sessionId];
    if (!session) return;
    session.encryptedTokens = encrypt(JSON.stringify(tokens), this.keyHex);
    session.updatedAt = Date.now();
    this.save();
  }

  deleteByRefreshToken(refreshToken: string): boolean {
    const hash = sha256(refreshToken);
    const id = Object.keys(this.data.sessions).find(
      (k) => this.data.sessions[k]?.tokenHash === hash
    );
    if (!id) return false;
    delete this.data.sessions[id];
    this.save();
    return true;
  }

  deleteByBridgeToken(bridgeToken: string): boolean {
    return this.deleteByRefreshToken(bridgeToken);
  }
}
