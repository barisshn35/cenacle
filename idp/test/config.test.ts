// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDatabaseConfig } from '../src/config.ts';

const DB = 'postgres://idp:idp@localhost:15432/cenacle_idp';
const KEK = Buffer.alloc(32, 7).toString('base64');
const COOKIE = 'c'.repeat(32);

const base = {
  IDP_DATABASE_URL: DB,
  IDP_COOKIE_KEYS: COOKIE,
  IDP_KEY_ENCRYPTION_KEY: KEK,
  IDP_CLIENTS_FILE: '/etc/cenacle/clients.json',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8190);
    expect(c.host).toBe('127.0.0.1');
    expect(c.issuer).toBe('http://localhost:8190');
    expect(c.database).toEqual({ url: DB, poolMax: 10 });
    expect(c.keyEncryptionKey).toHaveLength(32);
    expect(c.cookieKeys).toEqual([COOKIE]);
    expect(c.trustProxy).toBe(false);
    expect(c.loginRateLimit).toBe(10);
    expect(loadConfig({ ...base, IDP_LOGIN_RATE_LIMIT: '600' }).loginRateLimit).toBe(600);
    expect(() => loadConfig({ ...base, IDP_LOGIN_RATE_LIMIT: '0' })).toThrow(/IDP_LOGIN_RATE_LIMIT/);
  });

  it('reads *_FILE secrets and splits cookie keys', () => {
    const files: Record<string, string> = {
      '/run/secrets/db': `${DB}\n`,
      '/run/secrets/cookies': `${'a'.repeat(32)}\n${'b'.repeat(40)}\n`,
    };
    const c = loadConfig(
      {
        ...base,
        IDP_DATABASE_URL: undefined,
        IDP_COOKIE_KEYS: undefined,
        IDP_DATABASE_URL_FILE: '/run/secrets/db',
        IDP_COOKIE_KEYS_FILE: '/run/secrets/cookies',
      },
      (p) => files[p]!,
    );
    expect(c.database.url).toBe(DB);
    expect(c.cookieKeys).toEqual(['a'.repeat(32), 'b'.repeat(40)]);
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({
        ...base,
        IDP_PORT: '99999',
        IDP_ISSUER: 'https://id.example.com/',
        IDP_DATABASE_URL: 'mysql://x',
        IDP_ENV: 'staging',
        IDP_KEY_ENCRYPTION_KEY: 'c2hvcnQ=',
        IDP_COOKIE_KEYS: 'short',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const keys = (err as ConfigError).issues.map((i) => i.split(':')[0]);
      expect(keys).toEqual(
        expect.arrayContaining([
          'IDP_PORT',
          'IDP_ISSUER',
          'IDP_DATABASE_URL',
          'IDP_ENV',
          'IDP_KEY_ENCRYPTION_KEY',
          'IDP_COOKIE_KEYS',
        ]),
      );
    }
  });

  it('rejects both NAME and NAME_FILE', () => {
    expect(() => loadConfig({ ...base, IDP_DATABASE_URL_FILE: '/x' }, () => DB)).toThrow(
      /both set/,
    );
  });

  it('requires the server secrets', () => {
    expect(() => loadConfig({ IDP_DATABASE_URL: DB })).toThrow(ConfigError);
    try {
      loadConfig({ IDP_DATABASE_URL: DB });
    } catch (err) {
      const keys = (err as ConfigError).issues.map((i) => i.split(':')[0]);
      expect(keys).toEqual(
        expect.arrayContaining(['IDP_COOKIE_KEYS', 'IDP_KEY_ENCRYPTION_KEY', 'IDP_CLIENTS_FILE']),
      );
    }
  });
});

describe('loadDatabaseConfig', () => {
  it('needs only the database URL', () => {
    expect(loadDatabaseConfig({ IDP_DATABASE_URL: DB })).toEqual({ url: DB, poolMax: 10 });
  });

  it('requires a database URL', () => {
    expect(() => loadDatabaseConfig({})).toThrow(/IDP_DATABASE_URL/);
  });
});
