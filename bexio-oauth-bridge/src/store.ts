import fs from "node:fs";
import path from "node:path";
import { encrypt, decrypt, randomToken, sha256 } from "./crypto.js";

export interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // unix ms
  scope?: string;
  tokenType?: string;
}

interface Pending {
  codeVerifier: string;
  label: string | null;
  createdAt: number;
}

interface Session {
  id: string;
  bridgeTokenHash: string;
  label: string | null;
  encryptedTokens: string;
  createdAt: number;
  updatedAt: number;
}

interface DbFile {
  pending: Record<string, Pending>;
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
      return { pending: {}, sessions: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as DbFile;
    } catch {
      return { pending: {}, sessions: {} };
    }
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  savePending(state: string, codeVerifier: string, label?: string): void {
    this.data.pending[state] = {
      codeVerifier,
      label: label ?? null,
      createdAt: Date.now(),
    };
    this.save();
  }

  takePending(
    state: string
  ): { codeVerifier: string; label: string | null } | undefined {
    const row = this.data.pending[state];
    if (!row) return undefined;
    delete this.data.pending[state];
    this.save();
    return { codeVerifier: row.codeVerifier, label: row.label };
  }

  createSession(
    tokens: TokenBundle,
    label?: string | null
  ): { sessionId: string; bridgeToken: string } {
    const sessionId = randomToken(16);
    const bridgeToken = randomToken(32);
    const now = Date.now();
    this.data.sessions[sessionId] = {
      id: sessionId,
      bridgeTokenHash: sha256(bridgeToken),
      label: label ?? null,
      encryptedTokens: encrypt(JSON.stringify(tokens), this.keyHex),
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    return { sessionId, bridgeToken };
  }

  getByBridgeToken(bridgeToken: string): {
    sessionId: string;
    label: string | null;
    tokens: TokenBundle;
  } | undefined {
    const hash = sha256(bridgeToken);
    const session = Object.values(this.data.sessions).find(
      (s) => s.bridgeTokenHash === hash
    );
    if (!session) return undefined;
    const tokens = JSON.parse(
      decrypt(session.encryptedTokens, this.keyHex)
    ) as TokenBundle;
    return {
      sessionId: session.id,
      label: session.label,
      tokens,
    };
  }

  updateTokens(sessionId: string, tokens: TokenBundle): void {
    const session = this.data.sessions[sessionId];
    if (!session) return;
    session.encryptedTokens = encrypt(JSON.stringify(tokens), this.keyHex);
    session.updatedAt = Date.now();
    this.save();
  }

  deleteByBridgeToken(bridgeToken: string): boolean {
    const hash = sha256(bridgeToken);
    const id = Object.keys(this.data.sessions).find(
      (k) => this.data.sessions[k]?.bridgeTokenHash === hash
    );
    if (!id) return false;
    delete this.data.sessions[id];
    this.save();
    return true;
  }
}
