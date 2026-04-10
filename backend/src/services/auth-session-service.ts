import { createHash, randomBytes } from "node:crypto";

import type { AppConfig } from "../domain/config.js";
import type { AuthSessionView } from "../domain/types.js";
import { DatabaseService } from "../storage/database.js";
import { createId } from "../utils/id.js";
import { verifyPassword } from "../utils/password.js";
import { nowIso } from "../utils/time.js";

interface ActiveSession {
  id: string;
  username: string;
  expiresAt: string;
}

export class AuthSessionService {
  public constructor(
    private readonly config: AppConfig,
    private readonly storage: DatabaseService,
  ) {}

  public isAuthenticationEnabled(): boolean {
    return this.config.auth.enabled;
  }

  public async login(username: string, password: string): Promise<{ token: string; session: AuthSessionView }> {
    if (!this.config.auth.enabled) {
      throw new Error("Authentication is not enabled.");
    }

    const validUsername = username === this.config.auth.username;
    const validPassword = await this.verifyPassword(password);
    if (!validUsername || !validPassword) {
      throw new Error("Invalid username or password.");
    }

    const token = randomBytes(32).toString("hex");
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + this.config.auth.sessionTtlHours * 60 * 60 * 1000).toISOString();

    this.storage.createAuthSession({
      id: createId("session"),
      username,
      tokenHash: this.hashToken(token),
      createdAt,
      expiresAt,
      lastSeenAt: createdAt,
    });

    return {
      token,
      session: {
        isAuthenticationEnabled: this.requiresAuthorization(),
        supportsPasswordLogin: this.config.auth.enabled,
        isAuthenticated: true,
        username,
        expiresAt,
      },
    };
  }

  public async logout(token?: string): Promise<void> {
    if (token && this.config.apiToken && token === this.config.apiToken) {
      return;
    }

    const session = this.getActiveSession(token);
    if (!session) {
      return;
    }
    this.storage.revokeAuthSession(session.id, nowIso());
  }

  public async getSessionView(token?: string): Promise<AuthSessionView> {
    if (token && this.config.apiToken && token === this.config.apiToken) {
      return {
        isAuthenticationEnabled: this.requiresAuthorization(),
        supportsPasswordLogin: this.config.auth.enabled,
        isAuthenticated: true,
        username: "api-token",
      };
    }

    const session = this.getActiveSession(token);
    return {
      isAuthenticationEnabled: this.requiresAuthorization(),
      supportsPasswordLogin: this.config.auth.enabled,
      isAuthenticated: Boolean(session),
      username: session?.username,
      expiresAt: session?.expiresAt,
    };
  }

  public async isAuthorized(token?: string): Promise<boolean> {
    if (!this.requiresAuthorization()) {
      return true;
    }

    if (token && this.config.apiToken && token === this.config.apiToken) {
      return true;
    }

    return Boolean(this.getActiveSession(token));
  }

  private async verifyPassword(password: string): Promise<boolean> {
    if (this.config.auth.passwordHash) {
      return verifyPassword(password, this.config.auth.passwordHash);
    }

    return Boolean(this.config.auth.password && password === this.config.auth.password);
  }

  private requiresAuthorization(): boolean {
    return Boolean(this.config.apiToken || this.config.auth.enabled);
  }

  private getActiveSession(token?: string): ActiveSession | undefined {
    if (!token) {
      return undefined;
    }

    const now = nowIso();
    this.storage.revokeAllExpiredSessions(now);

    const record = this.storage.getAuthSessionByTokenHash(this.hashToken(token));
    if (!record || record.revokedAt || record.expiresAt <= now) {
      return undefined;
    }

    this.storage.touchAuthSession(record.id, now);
    return {
      id: record.id,
      username: record.username,
      expiresAt: record.expiresAt,
    };
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
