// SPDX-License-Identifier: AGPL-3.0-only
// Prometheus metrics of Cenacle ID, served on a separate internal port.
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'cenacle_idp_' });

const httpDuration = new Histogram({
  name: 'cenacle_idp_http_request_duration_seconds',
  help: 'Duration of HTTP requests by route.',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/** Outcomes of OIDC steps (authorization, token grant) by result. */
export const oidcEvents = new Counter({
  name: 'cenacle_idp_oidc_events_total',
  help: 'OIDC authorization and grant outcomes.',
  labelNames: ['event', 'result'],
  registers: [registry],
});

/** Records request durations by route pattern (never by raw path). */
export function instrument(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    done();
  });
}

/** Adds the database pool's state. */
export function registerPool(pool: pg.Pool): void {
  new Gauge({
    name: 'cenacle_idp_db_pool_connections',
    help: 'Database connections by state.',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });
}

/** Serves /metrics on host:port. */
export function serveMetrics(host: string, port: number): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => res.writeHead(200, { 'Content-Type': registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  server.listen(port, host);
  return server;
}
