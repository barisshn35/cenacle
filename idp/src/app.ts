// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { sendProblem } from './problem.ts';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export interface ReadinessCheck {
  name: string;
  check: (signal: AbortSignal) => Promise<void>;
}

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  checks?: ReadinessCheck[];
  readyTimeoutMs?: number;
}

/** Request IDs share the format of the chat server: REQ-<base32>. */
export function newRequestId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (const b of randomBytes(16)) out += alphabet[b & 31];
  return `REQ-${out}`;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const checks = opts.checks ?? [];
  const readyTimeoutMs = opts.readyTimeoutMs ?? 2000;

  const app = Fastify({
    logger: opts.logger ?? false,
    requestIdHeader: false,
    requestIdLogLabel: 'request_id',
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)
        ? incoming
        : newRequestId();
    },
    disableRequestLogging: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
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

  return app;
}
