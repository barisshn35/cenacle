// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Identity server configuration. Every variable can also be read from a file
 * by setting `<NAME>_FILE` (Docker/Compose secrets). Host names, issuer and
 * cookie domain always come from configuration and are never hard-coded, so
 * Cenacle ID can be installed under any domain.
 */
const schema = z.object({
  IDP_ENV: z.enum(['development', 'production']).default('development'),
  IDP_HOST: z.string().min(1).default('127.0.0.1'),
  IDP_PORT: z.coerce.number().int().min(1).max(65535).default(8190),
  IDP_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Public issuer URL, e.g. https://id.example.com. Used from v0.2 (OIDC). */
  IDP_ISSUER: z.url({ protocol: /^https?$/ }).default('http://localhost:8190'),
  /** Cookie domain for IdP sessions; empty means host-only cookies. */
  IDP_COOKIE_DOMAIN: z.string().default(''),
  IDP_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  IDP_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  IDP_READY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
  IDP_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
});

export type Config = {
  env: 'development' | 'production';
  host: string;
  port: number;
  logLevel: z.infer<typeof schema>['IDP_LOG_LEVEL'];
  issuer: string;
  cookieDomain: string;
  database: { url: string; poolMax: number };
  readyTimeoutMs: number;
  shutdownTimeoutMs: number;
};

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

/** Resolves `<NAME>_FILE` indirections for the keys of the schema. */
function resolveFiles(env: Env, readFile: ReadFile): { values: Env; issues: string[] } {
  const values: Env = {};
  const issues: string[] = [];
  for (const key of Object.keys(schema.shape)) {
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

export function loadConfig(
  env: Env = process.env,
  readFile: ReadFile = (p) => readFileSync(p, 'utf8'),
): Config {
  const { values, issues } = resolveFiles(env, readFile);
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }
  if (issues.length > 0 || !parsed.success) throw new ConfigError(issues);

  const c = parsed.data;
  return {
    env: c.IDP_ENV,
    host: c.IDP_HOST,
    port: c.IDP_PORT,
    logLevel: c.IDP_LOG_LEVEL,
    issuer: c.IDP_ISSUER,
    cookieDomain: c.IDP_COOKIE_DOMAIN,
    database: { url: c.IDP_DATABASE_URL, poolMax: c.IDP_DATABASE_POOL_MAX },
    readyTimeoutMs: c.IDP_READY_TIMEOUT_MS,
    shutdownTimeoutMs: c.IDP_SHUTDOWN_TIMEOUT_MS,
  };
}
