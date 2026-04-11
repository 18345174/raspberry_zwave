import { config as loadDotEnv } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(moduleDir, "..", "..");

loadDotEnv({ path: path.join(backendRoot, ".env") });
loadDotEnv({ path: path.resolve(process.cwd(), ".env") });

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
  zwaveCacheDir: string;
  zwaveDeviceConfigDir?: string;
  debugApiEnabled: boolean;
  apiToken?: string;
  securityKeys: Partial<Record<SecurityKeyName, string>>;
  auth: AuthConfig;
}

export interface AuthConfig {
  enabled: boolean;
  username: string;
  password?: string;
  passwordHash?: string;
  sessionTtlHours: number;
}

export type SecurityKeyName =
  | "S0_Legacy"
  | "S2_Unauthenticated"
  | "S2_Authenticated"
  | "S2_AccessControl";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value == undefined) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function ensureDirectory(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function loadPersistedSecurityKeys(dataDir: string): Partial<Record<SecurityKeyName, string>> {
  const filePath = path.join(dataDir, "zwave-security-keys.json");
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Partial<Record<SecurityKeyName, string>>;
  } catch {
    return {};
  }
}

function resolveSecurityKeys(dataDir: string): Partial<Record<SecurityKeyName, string>> {
  const persisted = loadPersistedSecurityKeys(dataDir);
  const resolved: Partial<Record<SecurityKeyName, string>> = {
    S0_Legacy: optional("ZWAVE_KEY_S0_LEGACY") ?? persisted.S0_Legacy,
    S2_Unauthenticated: optional("ZWAVE_KEY_S2_UNAUTHENTICATED") ?? persisted.S2_Unauthenticated,
    S2_Authenticated: optional("ZWAVE_KEY_S2_AUTHENTICATED") ?? persisted.S2_Authenticated,
    S2_AccessControl: optional("ZWAVE_KEY_S2_ACCESS_CONTROL") ?? persisted.S2_AccessControl,
  };

  let generated = false;
  for (const key of ["S0_Legacy", "S2_Unauthenticated", "S2_Authenticated", "S2_AccessControl"] as SecurityKeyName[]) {
    if (!resolved[key]) {
      resolved[key] = randomBytes(16).toString("hex");
      generated = true;
    }
  }

  if (generated || JSON.stringify(resolved) !== JSON.stringify(persisted)) {
    const filePath = path.join(dataDir, "zwave-security-keys.json");
    writeFileSync(filePath, JSON.stringify(resolved, null, 2));
    if (generated) {
      console.info(`[config] Generated persistent Z-Wave security keys at ${filePath}`);
    }
  }

  return resolved;
}

export function loadAppConfig(): AppConfig {
  const dataDir = ensureDirectory(env("DATA_DIR", path.resolve(process.cwd(), "data")));
  const logDir = ensureDirectory(env("LOG_DIR", path.join(dataDir, "logs")));
  const zwaveCacheDir = ensureDirectory(
    env("ZWAVE_CACHE_DIR", path.join(dataDir, "zwave")),
  );
  const securityKeys = resolveSecurityKeys(dataDir);

  return {
    host: env("HOST", "0.0.0.0"),
    port: Number(env("PORT", "8080")),
    dataDir,
    logDir,
    zwaveCacheDir,
    zwaveDeviceConfigDir: optional("ZWAVE_DEVICE_CONFIG_DIR"),
    debugApiEnabled: booleanEnv("DEBUG_API_ENABLED", false),
    apiToken: optional("API_TOKEN"),
    securityKeys,
    auth: {
      enabled: Boolean(optional("ADMIN_PASSWORD") || optional("ADMIN_PASSWORD_HASH")),
      username: env("ADMIN_USERNAME", "admin"),
      password: optional("ADMIN_PASSWORD"),
      passwordHash: optional("ADMIN_PASSWORD_HASH"),
      sessionTtlHours: Number(env("AUTH_SESSION_TTL_HOURS", "24")),
    },
  };
}
