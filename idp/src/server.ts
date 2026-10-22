// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { AuditLog } from './accounts/audit.ts';
import { MfaStore } from './accounts/mfa.ts';
import { PasskeyStore } from './accounts/passkeys.ts';
import { UserStore } from './accounts/users.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createPool, poolCheck } from './db.ts';
import { SourceStore } from './directory/store.ts';
import { ProviderStore } from './federation/store.ts';
import { scheduleSync } from './directory/sync.ts';
import { instrument, oidcEvents, registerPool, serveMetrics } from './metrics.ts';
import { KeyStore } from './keys/store.ts';
import { pruneExpired } from './oidc/adapter.ts';
import { clientOrigins, loadClients } from './oidc/clients.ts';
import { createProvider } from './oidc/provider.ts';

const ASSETS_DIR = fileURLToPath(new URL('../public/assets', import.meta.url));
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const pool = createPool(config.database);
  pool.on('error', () => {
    // Idle client errors (e.g. database restart) are reported by /readyz.
  });

  const keys = new KeyStore(pool, config.keyEncryptionKey);
  await keys.ensureActiveKey();
  const signingKeys = await keys.loadSigningKeys(config.retiredKeyGraceSeconds);
  const clients = loadClients(config.clientsFile);
  const users = new UserStore(pool);
  const sources = new SourceStore(pool, config.keyEncryptionKey);
  const formActionOrigins = clientOrigins(clients);

  const provider = createProvider({
    issuer: config.issuer,
    pool,
    users,
    clients,
    signingKeys,
    cookieKeys: config.cookieKeys,
    cookieDomain: config.cookieDomain,
    trustProxy: config.trustProxy,
    formActionOrigins,
  });

  const app = await buildApp({
    logger: {
      level: config.logLevel,
      base: { service: 'cenacle-idp' },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    checks: [poolCheck(pool)],
    readyTimeoutMs: config.readyTimeoutMs,
    trustProxy: config.trustProxy,
    assetsDir: ASSETS_DIR,
    oidc: {
      provider,
      users,
      issuer: config.issuer,
      formActionOrigins,
      loginRateLimit: config.loginRateLimit,
      mfa: new MfaStore(pool, config.keyEncryptionKey),
      audit: new AuditLog(pool, (err) => console.error('audit log write failed', err)),
      cookieKeys: config.cookieKeys,
      directory: { pool, sources },
      passkeys: new PasskeyStore(pool, config.issuer),
      federation: new ProviderStore(pool, config.keyEncryptionKey),
      clients,
    },
  });

  provider.on('server_error', (_ctx, err) => app.log.error({ err }, 'oidc server error'));
  provider.on('authorization.success', () =>
    oidcEvents.inc({ event: 'authorization', result: 'success' }),
  );
  provider.on('authorization.error', () =>
    oidcEvents.inc({ event: 'authorization', result: 'error' }),
  );
  provider.on('grant.success', () => oidcEvents.inc({ event: 'grant', result: 'success' }));
  provider.on('grant.error', () => oidcEvents.inc({ event: 'grant', result: 'error' }));
  instrument(app);
  registerPool(pool);
  const metrics =
    config.metricsPort > 0 ? serveMetrics(config.host, config.metricsPort) : undefined;
  provider.on('backchannel.error', (_ctx, err, client) =>
    app.log.warn({ err, client: client.clientId }, 'back-channel logout failed'),
  );

  const prune = setInterval(() => {
    pruneExpired(pool)
      .then((n) => n > 0 && app.log.info({ removed: n }, 'expired oidc artifacts removed'))
      .catch((err: unknown) => app.log.warn({ err }, 'pruning expired artifacts failed'));
  }, PRUNE_INTERVAL_MS);
  prune.unref();
  const sync = scheduleSync(pool, sources, app.log);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('graceful shutdown timed out');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    timer.unref();
    clearInterval(prune);
    clearInterval(sync);
    metrics?.close();
    await app.close();
    await pool.end();
    app.log.info('shutdown complete');
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { issuer: config.issuer, env: config.env, clients: clients.map((c) => c.client_id) },
    'identity server ready',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
