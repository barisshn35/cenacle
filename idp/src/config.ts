// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Identity server configuration. Every variable can also be read from a file
 * by setting `<NAME>_FILE` (Docker/Compose secrets). Host names, issuer and
 * cookie domain always come from configuration and are never hard-coded, so
 * Cenacle ID can be installed under any domain.
 */
const databaseSchema = z.object({
  IDP_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  IDP_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

const keySchema = databaseSchema.extend({
  /** Base64 encoded 32-byte key that encrypts token signing keys at rest. */
  IDP_KEY_ENCRYPTION_KEY: z
    .string()
    .transform((v) => Buffer.from(v.trim(), 'base64'))
    .refine((b) => b.length === 32, 'must be 32 bytes, base64 encoded'),
  /** How long a rotated-out signing key stays published, in seconds (default 7 days). */
  IDP_KEY_RETIRED_GRACE_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(7 * 24 * 3600),
});

const serverSchema = keySchema.extend({
  IDP_ENV: z.enum(['development', 'production']).default('development'),
  IDP_HOST: z.string().min(1).default('127.0.0.1'),
  IDP_PORT: z.coerce.number().int().min(1).max(65535).default(8190),
  IDP_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Public issuer URL, e.g. https://id.example.com (no trailing slash). */
  IDP_ISSUER: z
    .url({ protocol: /^https?$/ })
    .default('http://localhost:8190')
    .refine((v) => !v.endsWith('/'), 'must not end with a slash'),
  /** Cookie domain for IdP sessions; empty means host-only cookies. */
  IDP_COOKIE_DOMAIN: z.string().default(''),
  /** Cookie signing keys, newest first, separated by newlines or commas. */
  IDP_COOKIE_KEYS: z
    .string()
    .transform((v) =>
      v
        .split(/[\n,]/)
        .map((k) => k.trim())
        .filter(Boolean),
    )
    .refine((keys) => keys.length > 0, 'at least one key is required')
    .refine((keys) => keys.every((k) => k.length >= 32), 'each key needs at least 32 characters'),
  /** JSON file with the registered OIDC clients. */
  IDP_CLIENTS_FILE: z.string().min(1),
  /** Trust X-Forwarded-* headers (set when running behind the Caddy proxy). */
  IDP_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  IDP_READY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
  /** Sign-in attempts per client address and minute (raise it for many users behind one NAT). */
  IDP_LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(10),
  /** A notice people accept before signing in (DISA STIG notice and consent banner). */
  IDP_SIGNIN_NOTICE: z.string().max(10_000).optional(),
  IDP_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  /** Port for Prometheus metrics on IDP_HOST (internal); 0: off. */
  IDP_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
});

export interface DatabaseConfig {
  url: string;
  poolMax: number;
}

export interface KeyConfig {
  database: DatabaseConfig;
  keyEncryptionKey: Buffer;
  retiredKeyGraceSeconds: number;
}

export interface Config {
  env: 'development' | 'production';
  host: string;
  port: number;
  logLevel: z.infer<typeof serverSchema>['IDP_LOG_LEVEL'];
  issuer: string;
  cookieDomain: string;
  cookieKeys: string[];
  keyEncryptionKey: Buffer;
  retiredKeyGraceSeconds: number;
  clientsFile: string;
  trustProxy: boolean;
  database: DatabaseConfig;
  readyTimeoutMs: number;
  shutdownTimeoutMs: number;
  loginRateLimit: number;
  signinNotice?: string;
  metricsPort: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

/** Resolves `<NAME>_FILE` indirections for the given keys. */
function resolveFiles(
  keys: string[],
  env: Env,
  readFile: ReadFile,
): { values: Env; issues: string[] } {
  const values: Env = {};
  const issues: string[] = [];
  for (const key of keys) {
    const direct = env[key];
    const file = env[`${key}_FILE`];
    if (direct !== undefined && file !== undefined) {
      issues.push(`${key}: ${key} and ${key}_FILE are both set; use only one`);
    } else if (file !== undefined) {
      try {
        values[key] = readFile(file).replace(/[\r\n]+$/, '');
      } catch (err) {
        issues.push(`${key}_FILE: ${(err as Error).message}`);
      }
    } else if (direct !== undefined && direct !== '') {
      values[key] = direct;
    }
  }
  return { values, issues };
}

function parse<S extends z.ZodObject>(schema: S, env: Env, readFile: ReadFile): z.infer<S> {
  const { values, issues } = resolveFiles(Object.keys(schema.shape), env, readFile);
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }
  if (issues.length > 0 || !parsed.success) throw new ConfigError(issues);
  return parsed.data;
}

const defaultReadFile: ReadFile = (p) => readFileSync(p, 'utf8');

/** Database settings only: enough for maintenance commands such as migrations. */
export function loadDatabaseConfig(
  env: Env = process.env,
  readFile: ReadFile = defaultReadFile,
): DatabaseConfig {
  const c = parse(databaseSchema, env, readFile);
  return { url: c.IDP_DATABASE_URL, poolMax: c.IDP_DATABASE_POOL_MAX };
}

/** Database and signing key settings: enough for key maintenance commands. */
export function loadKeyConfig(
  env: Env = process.env,
  readFile: ReadFile = defaultReadFile,
): KeyConfig {
  const c = parse(keySchema, env, readFile);
  return {
    database: { url: c.IDP_DATABASE_URL, poolMax: c.IDP_DATABASE_POOL_MAX },
    keyEncryptionKey: c.IDP_KEY_ENCRYPTION_KEY,
    retiredKeyGraceSeconds: c.IDP_KEY_RETIRED_GRACE_SECONDS,
  };
}

/** Full configuration of the identity server. */
export function loadConfig(env: Env = process.env, readFile: ReadFile = defaultReadFile): Config {
  const c = parse(serverSchema, env, readFile);
  return {
    env: c.IDP_ENV,
    host: c.IDP_HOST,
    port: c.IDP_PORT,
    logLevel: c.IDP_LOG_LEVEL,
    issuer: c.IDP_ISSUER,
    cookieDomain: c.IDP_COOKIE_DOMAIN,
    cookieKeys: c.IDP_COOKIE_KEYS,
    keyEncryptionKey: c.IDP_KEY_ENCRYPTION_KEY,
    retiredKeyGraceSeconds: c.IDP_KEY_RETIRED_GRACE_SECONDS,
    clientsFile: c.IDP_CLIENTS_FILE,
    trustProxy: c.IDP_TRUST_PROXY,
    database: { url: c.IDP_DATABASE_URL, poolMax: c.IDP_DATABASE_POOL_MAX },
    readyTimeoutMs: c.IDP_READY_TIMEOUT_MS,
    shutdownTimeoutMs: c.IDP_SHUTDOWN_TIMEOUT_MS,
    loginRateLimit: c.IDP_LOGIN_RATE_LIMIT,
    signinNotice: c.IDP_SIGNIN_NOTICE,
    metricsPort: c.IDP_METRICS_PORT,
  };
}
