// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const DB = 'postgres://idp:idp@localhost:15432/cenacle_idp';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ IDP_DATABASE_URL: DB });
    expect(c.port).toBe(8190);
    expect(c.host).toBe('127.0.0.1');
    expect(c.issuer).toBe('http://localhost:8190');
    expect(c.database).toEqual({ url: DB, poolMax: 10 });
  });

  it('reads *_FILE secrets', () => {
    const c = loadConfig({ IDP_DATABASE_URL_FILE: '/run/secrets/db' }, (p) => {
      expect(p).toBe('/run/secrets/db');
      return `${DB}\n`;
    });
    expect(c.database.url).toBe(DB);
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({
        IDP_PORT: '99999',
        IDP_ISSUER: 'ftp://id',
        IDP_DATABASE_URL: 'mysql://x',
        IDP_ENV: 'staging',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const keys = (err as ConfigError).issues.map((i) => i.split(':')[0]);
      expect(keys).toEqual(
        expect.arrayContaining(['IDP_PORT', 'IDP_ISSUER', 'IDP_DATABASE_URL', 'IDP_ENV']),
      );
    }
  });

  it('rejects both NAME and NAME_FILE', () => {
    expect(() =>
      loadConfig({ IDP_DATABASE_URL: DB, IDP_DATABASE_URL_FILE: '/x' }, () => DB),
    ).toThrow(/both set/);
  });

  it('requires a database URL', () => {
    expect(() => loadConfig({})).toThrow(/IDP_DATABASE_URL/);
  });
});
