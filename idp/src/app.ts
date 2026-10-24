// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type Provider from 'oidc-provider';
import type { AuditLog } from './accounts/audit.ts';
import type { MfaStore } from './accounts/mfa.ts';
import type { UserStore } from './accounts/users.ts';
import { registerAccount } from './account/routes.ts';
import type { PasskeyStore } from './accounts/passkeys.ts';
import type { PolicyStore } from './accounts/policy.ts';
import { registerFederation } from './federation/routes.ts';
import type { ProviderStore } from './federation/store.ts';
import { registerAdmin } from './admin/routes.ts';
import { registerDirectoryFeed } from './directory/feed.ts';
import { registerScim } from './scim/routes.ts';
import type { ClientMetadata } from './oidc/clients.ts';
import type { DirectoryAccess } from './accounts/signin.ts';
import { registerInteractions } from './oidc/interactions.ts';
import { sendProblem } from './problem.ts';
import { configurePages } from './ui/pages.ts';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Paths served by oidc-provider (default routes plus discovery). */
const PROVIDER_PREFIXES = [
  '/.well-known/',
  '/auth',
  '/token',
  '/me',
  '/jwks',
  '/session/end',
  '/request',
];

export function isProviderPath(path: string): boolean {
  return PROVIDER_PREFIXES.some((p) =>
    p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`),
  );
}

export interface ReadinessCheck {
  name: string;
  check: (signal: AbortSignal) => Promise<void>;
}

export interface OidcOptions {
  provider: Provider;
  users: UserStore;
  issuer: string;
  formActionOrigins: string[];
  loginRateLimit?: number;
  /** Two-step verification and audit log; with cookieKeys they enable /account. */
  mfa?: MfaStore;
  audit?: AuditLog;
  cookieKeys?: string[];
  /** Directories (LDAP / Active Directory) people may sign in with. */
  directory?: DirectoryAccess;
  /** Passkeys (WebAuthn) for signing in. */
  passkeys?: PasskeyStore;
  /** Identity providers (OIDC, SAML) people may sign in with. */
  federation?: ProviderStore;
  /** Registered apps (the directory feed authenticates them). */
  clients?: ClientMetadata[];
  /** The sign-in policy (two-step required, passkeys allowed). */
  policy?: PolicyStore;
}

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  checks?: ReadinessCheck[];
  readyTimeoutMs?: number;
  /** Mounts the OpenID Provider and the sign-in pages. */
  oidc?: OidcOptions;
  /** Directory with the built page assets (served under /assets/). */
  assetsDir?: string;
  trustProxy?: boolean;
}

/** Request IDs share the format of the chat server: REQ-<base32>. */
export function newRequestId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (const b of randomBytes(16)) out += alphabet[b & 31];
  return `REQ-${out}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const name = part.slice(0, i).trim();
      try {
        out[name] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // Ignore malformed cookie values.
      }
    }
  }
  return out;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const checks = opts.checks ?? [];
  const readyTimeoutMs = opts.readyTimeoutMs ?? 2000;

  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? false,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)
        ? incoming
        : newRequestId();
    },
  });

  app.decorateRequest(
    'cookieValue',
    function (this: { headers: { cookie?: string } }, name: string) {
      return parseCookies(this.headers.cookie)[name];
    },
  );

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');

    // Hand OIDC endpoints to oidc-provider before Fastify parses the body.
    if (opts.oidc && isProviderPath(request.url.split('?')[0]!)) {
      request.raw.headers[REQUEST_ID_HEADER] = request.id;
      reply.raw.setHeader(REQUEST_ID_HEADER, request.id);
      reply.hijack();
      await opts.oidc.provider.callback()(request.raw, reply.raw);
      return reply;
    }
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, {
      status: 404,
      code: 'not_found',
      detail: 'No resource exists at this path.',
    }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return sendProblem(request, reply, { status, code: 'internal_error' });
    }
    return sendProblem(request, reply, {
      status,
      code: error.code ? error.code.toLowerCase() : 'bad_request',
      detail: error.message,
    });
  });

  app.get('/healthz', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'ok' }),
  );

  app.get('/readyz', async (request, reply) => {
    const signal = AbortSignal.timeout(readyTimeoutMs);
    const results = await Promise.all(
      checks.map(async (c) => {
        try {
          await c.check(signal);
          return [c.name, 'ok'] as const;
        } catch (err) {
          request.log.warn({ check: c.name, err }, 'readiness check failed');
          return [c.name, 'unavailable'] as const;
        }
      }),
    );
    const failed = results.filter(([, s]) => s !== 'ok').map(([n]) => n);
    if (failed.length > 0) {
      reply.header('retry-after', '5');
      return sendProblem(request, reply, {
        status: 503,
        code: 'service_unavailable',
        detail: `Not ready: ${failed.sort().join(', ')}.`,
      });
    }
    return reply
      .header('cache-control', 'no-store')
      .send({ status: 'ok', checks: Object.fromEntries(results) });
  });

  if (opts.assetsDir) {
    await app.register(fastifyStatic, {
      root: opts.assetsDir,
      prefix: '/assets/',
      index: false,
      maxAge: '1h',
    });
  }

  if (opts.oidc) {
    configurePages({ issuer: opts.oidc.issuer });
    await app.register(formbody, { bodyLimit: 16 * 1024 });
    await app.register(rateLimit, { global: false });
    await registerInteractions(app, opts.oidc);
    const { mfa, audit, cookieKeys } = opts.oidc;
    if (mfa && audit && cookieKeys) {
      await registerAccount(app, {
        users: opts.oidc.users,
        mfa,
        audit,
        cookieKeys,
        issuer: opts.oidc.issuer,
        formActionOrigins: opts.oidc.formActionOrigins,
        rateLimit: opts.oidc.loginRateLimit,
        directory: opts.oidc.directory,
        passkeys: opts.oidc.passkeys,
        federation: opts.oidc.federation,
        policy: opts.oidc.policy,
      });
      if (opts.oidc.federation && opts.oidc.directory) {
        await registerFederation(app, {
          pool: opts.oidc.directory.pool,
          providers: opts.oidc.federation,
          audit,
          issuer: opts.oidc.issuer,
          formActionOrigins: opts.oidc.formActionOrigins,
        });
        await registerScim(app, {
          pool: opts.oidc.directory.pool,
          providers: opts.oidc.federation,
          audit,
          issuer: opts.oidc.issuer,
        });
      }
      if (opts.oidc.directory && opts.oidc.clients) {
        registerDirectoryFeed(app, { pool: opts.oidc.directory.pool, clients: opts.oidc.clients });
      }
      if (opts.oidc.directory) {
        await registerAdmin(app, {
          pool: opts.oidc.directory.pool,
          users: opts.oidc.users,
          mfa,
          audit,
          sources: opts.oidc.directory.sources,
          providers: opts.oidc.federation,
          issuer: opts.oidc.issuer,
          cookieKeys,
          formActionOrigins: opts.oidc.formActionOrigins,
          policy: opts.oidc.policy,
        });
      }
    }
  }

  return app;
}
