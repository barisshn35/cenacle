// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type ReadinessCheck } from '../src/app.ts';

const ok: ReadinessCheck = { name: 'postgres', check: async () => {} };
const down: ReadinessCheck = {
  name: 'postgres',
  check: async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:15432');
  },
};

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe('idp http', () => {
  it('GET /healthz returns 200 with a request id', async () => {
    app = await buildApp({ checks: [down] });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^REQ-[A-Z2-7]{16}$/);
  });

  it('GET /readyz returns 200 when checks pass', async () => {
    app = await buildApp({ checks: [ok] });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } });
  });

  it('GET /readyz returns 503 problem+json without leaking details', async () => {
    app = await buildApp({ checks: [down] });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json(;|$)/);
    const body = res.json();
    expect(body).toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('unknown routes return problem+json with the request id', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'proxy-request-1234' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json(;|$)/);
    expect(res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No resource exists at this path.',
      code: 'not_found',
      request_id: 'proxy-request-1234',
    });
  });

  it('replaces malformed incoming request ids', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': '<bad id>' },
    });
    expect(res.headers['x-request-id']).toMatch(/^REQ-/);
  });
});
