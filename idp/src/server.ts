// SPDX-License-Identifier: Apache-2.0
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createPool, poolCheck } from './db.ts';

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

  const app = buildApp({
    logger: {
      level: config.logLevel,
      base: { service: 'cenacle-idp' },
      ...(config.env === 'development'
        ? {}
        : { redact: ['req.headers.authorization', 'req.headers.cookie'] }),
    },
    checks: [poolCheck(pool)],
    readyTimeoutMs: config.readyTimeoutMs,
  });

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
    await app.close();
    await pool.end();
    app.log.info('shutdown complete');
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ issuer: config.issuer, env: config.env }, 'identity server ready');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
