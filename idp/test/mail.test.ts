// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditLog } from '../src/accounts/audit.ts';
import type { MfaStore } from '../src/accounts/mfa.ts';
import type { User, UserStore } from '../src/accounts/users.ts';
import { ACCOUNT_COOKIE, signAccount } from '../src/account/session.ts';
import { registerAdmin } from '../src/admin/routes.ts';
import { loadConfig } from '../src/config.ts';
import type { SourceStore } from '../src/directory/store.ts';
import { Mailer, NoMailServer } from '../src/mail/send.ts';
import {
  addressOf,
  checkMailServer,
  MailServerStore,
  type MailServer,
} from '../src/mail/server.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

/** A mail server that takes everything and keeps the messages; optionally without STARTTLS. */
function fakeSmtp(): Promise<{ server: Server; port: number; mails: string[] }> {
  const mails: string[] = [];
  const server = createServer((socket: Socket) => {
    let data = false;
    let buffer = '';
    let message = '';
    const say = (line: string) => socket.write(line + '\r\n');
    say('220 fake');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === '.') {
            data = false;
            mails.push(message);
            message = '';
            say('250 queued');
          } else message += line + '\n';
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) say('250 fake');
        else if (cmd === 'STARTTLS') say('454 TLS not available');
        else if (cmd === 'DATA') {
          data = true;
          say('354 go on');
        } else if (cmd === 'QUIT') {
          say('221 bye');
          socket.end();
        } else say('250 ok');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, mails });
    }),
  );
}

const valid: MailServer = {
  host: 'mail.example.com',
  port: 587,
  security: 'starttls',
  username: 'id@example.com',
  password: 's3cret-pass',
  from: 'Cenacle ID <id@example.com>',
};

describe('the mail server as typed', () => {
  it('accepts a sound server and turns e-mail off with an empty host', () => {
    expect(checkMailServer(valid)).toBeNull();
    expect(
      checkMailServer({
        ...valid,
        host: '10.0.0.5',
        port: 25,
        security: 'none',
        username: '',
        password: '',
      }),
    ).toBeNull();
    expect(checkMailServer({ ...valid, host: '', port: 0, from: '' })).toBeNull();
  });

  it('refuses what would fail or leak', () => {
    expect(checkMailServer({ ...valid, host: 'https://mail.example.com' })).toBe('host');
    expect(checkMailServer({ ...valid, host: 'mail.example.com:587' })).toBe('host');
    expect(checkMailServer({ ...valid, port: 0 })).toBe('port');
    expect(checkMailServer({ ...valid, port: 70000 })).toBe('port');
    expect(checkMailServer({ ...valid, security: 'ssl' as never })).toBe('security');
    // A password must never travel unencrypted.
    expect(checkMailServer({ ...valid, security: 'none' })).toBe('clearAccount');
    expect(checkMailServer({ ...valid, from: 'Cenacle ID' })).toBe('from');
    expect(checkMailServer({ ...valid, from: 'a@b.com, c@d.com' })).toBe('from');
  });

  it('reads the address of a sender', () => {
    expect(addressOf('Cenacle ID <id@example.com>')).toBe('id@example.com');
    expect(addressOf('id@example.com')).toBe('id@example.com');
    expect(addressOf('<id@example.com> extra')).toBeNull();
  });
});

describe('the mail server in the configuration', () => {
  const base = {
    IDP_DATABASE_URL: 'postgres://u:p@localhost/db',
    IDP_COOKIE_KEYS: 'x'.repeat(32),
    IDP_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    IDP_CLIENTS_FILE: '/etc/cenacle/clients.json',
  };

  it('names it, or leaves it to the admin panel', () => {
    expect(loadConfig(base).smtp).toBeUndefined();
    const c = loadConfig({
      ...base,
      IDP_SMTP_HOST: 'relay.internal',
      IDP_SMTP_PORT: '25',
      IDP_SMTP_SECURITY: 'none',
      IDP_SMTP_FROM: 'id@example.com',
    });
    expect(c.smtp).toMatchObject({
      host: 'relay.internal',
      port: 25,
      security: 'none',
      username: '',
    });
  });

  it('fails at start on a mail server that cannot work', () => {
    expect(() =>
      loadConfig({
        ...base,
        IDP_SMTP_HOST: 'relay.internal',
        IDP_SMTP_SECURITY: 'none',
        IDP_SMTP_USERNAME: 'a',
        IDP_SMTP_FROM: 'a@b.c',
      }),
    ).toThrow(/IDP_SMTP_USERNAME needs/);
    expect(() => loadConfig({ ...base, IDP_SMTP_HOST: 'relay.internal' })).toThrow(/IDP_SMTP_FROM/);
  });

  it('takes the password from the variable when compose mounts an empty secret file', () => {
    const env = {
      ...base,
      IDP_SMTP_HOST: 'mail.example.com',
      IDP_SMTP_USERNAME: 'id@example.com',
      IDP_SMTP_PASSWORD: 'from-env',
      IDP_SMTP_PASSWORD_FILE: '/run/secrets/smtp_password',
      IDP_SMTP_FROM: 'id@example.com',
    };
    expect(loadConfig(env, () => '\n').smtp?.password).toBe('from-env');
    expect(() => loadConfig(env, () => 'from-file\n')).toThrow(/both set/);
    expect(loadConfig({ ...env, IDP_SMTP_PASSWORD: '' }, () => 'from-file\n').smtp?.password).toBe(
      'from-file',
    );
  });
});

describe('sending', () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  beforeAll(async () => {
    smtp = await fakeSmtp();
  });
  afterAll(() => smtp.server.close());

  const store = (s: MailServer | undefined) =>
    ({ current: async () => s ?? null }) as unknown as MailServerStore;

  it('sends through a relay inside the network', async () => {
    const mailer = new Mailer(
      store({
        host: '127.0.0.1',
        port: smtp.port,
        security: 'none',
        username: '',
        password: '',
        from: 'Cenacle ID <id@example.com>',
      }),
    );
    await mailer.send({
      to: 'ayse@example.com',
      subject: 'Deneme',
      text: 'Merhaba',
      html: '<p>Merhaba</p>',
    });
    const last = smtp.mails.at(-1) ?? '';
    expect(last).toMatch(/^From: Cenacle ID <id@example.com>$/m);
    expect(last).toMatch(/^To: ayse@example.com$/m);
    expect(last).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(last).toContain('multipart/alternative');
  });

  it('never falls back to an unencrypted connection when STARTTLS is required', async () => {
    const before = smtp.mails.length;
    const mailer = new Mailer(store({ ...valid, host: '127.0.0.1', port: smtp.port }));
    await expect(
      mailer.send({ to: 'ayse@example.com', subject: 's', text: 't' }),
    ).rejects.toThrow();
    expect(smtp.mails.length).toBe(before);
  });

  it('says when there is no mail server', async () => {
    await expect(
      new Mailer(store(undefined)).send({ to: 'a@b.c', subject: 's', text: 't' }),
    ).rejects.toBeInstanceOf(NoMailServer);
  });
});

describe.skipIf(!hasTestDatabase)('the stored mail server', () => {
  let pool: pg.Pool;
  const kek = randomBytes(32);
  beforeAll(async () => {
    pool = await openTestDatabase();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  it('keeps the password encrypted, keeps it when not typed again and drops it with the account', async () => {
    const servers = new MailServerStore(pool, kek);
    expect(await servers.current()).toBeNull();
    expect(await servers.set(valid)).toEqual({ passwordChanged: true });
    const { rows } = await pool.query<{ password_enc: Buffer }>(
      'SELECT password_enc FROM mail_server',
    );
    expect(rows[0]!.password_enc.toString('latin1')).not.toContain('s3cret');
    expect((await servers.current())?.password).toBe('s3cret-pass');
    expect(await servers.view()).toMatchObject({
      hasPassword: true,
      managed: false,
      host: 'mail.example.com',
    });
    expect(JSON.stringify(await servers.view())).not.toContain('s3cret');

    expect(await servers.set({ ...valid, password: '' })).toEqual({ passwordChanged: false });
    expect((await servers.current())?.password).toBe('s3cret-pass');

    // Another key cannot read it.
    await expect(new MailServerStore(pool, randomBytes(32)).current()).rejects.toThrow();

    await servers.set({ ...valid, security: 'none', port: 25, username: '', password: '' });
    expect((await servers.view()).hasPassword).toBe(false);
    await servers.set({ ...valid, host: '' });
    expect(await servers.current()).toBeNull();
    expect((await servers.view()).port).toBe(587);
  });

  it('shows the one the configuration names and does not change it', async () => {
    const servers = new MailServerStore(pool, kek, valid);
    expect(await servers.view()).toMatchObject({
      managed: true,
      hasPassword: true,
      host: 'mail.example.com',
    });
    expect('password' in (await servers.view())).toBe(false);
    await expect(servers.set(valid)).rejects.toThrow();
  });
});

describe('the admin panel page', () => {
  const ISSUER = 'https://id.example.com';
  const KEYS = ['a-cookie-key-for-the-tests-only'];
  const ADMIN = {
    id: '01900000-0000-7000-8000-000000000001',
    isAdmin: true,
    disabled: false,
    fromProvider: false,
    email: 'admin@example.com',
    displayName: 'Yönetici',
  } as User;
  const PERSON = { ...ADMIN, id: '01900000-0000-7000-8000-000000000002', isAdmin: false } as User;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  beforeAll(async () => {
    smtp = await fakeSmtp();
  });
  afterAll(() => smtp.server.close());

  async function app(fixed?: MailServer) {
    let saved: MailServer | null = null;
    const servers = {
      managed: fixed !== undefined,
      current: async () => fixed ?? saved,
      view: async () => {
        const s = fixed ?? saved;
        return {
          host: s?.host ?? '',
          port: s?.port ?? 587,
          security: s?.security ?? 'starttls',
          username: s?.username ?? '',
          from: s?.from ?? '',
          hasPassword: !!s?.password,
          managed: fixed !== undefined,
        };
      },
      set: async (s: MailServer) => {
        const changed = s.password !== '';
        saved = s.host ? { ...s, password: s.password || saved?.password || '' } : null;
        return { passwordChanged: changed };
      },
    } as unknown as MailServerStore;
    const a = Fastify();
    a.decorateRequest(
      'cookieValue',
      function (this: { headers: { cookie?: string } }, name: string) {
        const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(this.headers.cookie ?? '');
        return m?.[1];
      },
    );
    await a.register(formbody);
    const recorded: { action: string; detail: unknown }[] = [];
    await registerAdmin(a, {
      pool: {} as pg.Pool,
      users: {
        findById: async (id: string) => [ADMIN, PERSON].find((u) => u.id === id) ?? null,
      } as UserStore,
      mfa: { enabled: async () => true } as unknown as MfaStore,
      audit: {
        record: async (action: string, _actor: string, _ip: string, detail: unknown) =>
          void recorded.push({ action, detail }),
      } as unknown as AuditLog,
      sources: {} as SourceStore,
      issuer: ISSUER,
      cookieKeys: KEYS,
      formActionOrigins: [],
      mail: { servers, mailer: new Mailer(servers) },
    });
    return { a, recorded };
  }
  const as = (u: User) => ({ cookie: `${ACCOUNT_COOKIE}=${signAccount(KEYS, u.id)}` });
  const post = (u: User) => ({
    ...as(u),
    'sec-fetch-site': 'same-origin',
    origin: ISSUER,
    'content-type': 'application/x-www-form-urlencoded',
  });

  it('is for administrators, and only same-origin forms change it', async () => {
    const { a } = await app();
    expect((await a.inject({ url: '/account/admin/mail', headers: as(PERSON) })).statusCode).toBe(
      403,
    );
    const cross = await a.inject({
      method: 'POST',
      url: '/account/admin/mail',
      headers: { ...post(ADMIN), origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      payload: 'host=mail.example.com&port=587&security=starttls&username=&from=a%40b.c',
    });
    expect(cross.statusCode).toBe(403);
  });

  it('saves a mail server, never shows the password and sends the test e-mail', async () => {
    const { a, recorded } = await app();
    const page = await a.inject({ url: '/account/admin/mail', headers: as(ADMIN) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="host"');

    const bad = await a.inject({
      method: 'POST',
      url: '/account/admin/mail',
      headers: post(ADMIN),
      payload:
        'host=mail.example.com&port=25&security=none&username=id%40example.com&password=s3cret&from=id%40example.com',
    });
    // An account over an unencrypted connection: the account goes, so it is saved without one.
    expect(bad.statusCode).toBe(303);

    const wrong = await a.inject({
      method: 'POST',
      url: '/account/admin/mail',
      headers: post(ADMIN),
      payload:
        'host=https%3A%2F%2Fmail&port=587&security=starttls&username=&password=s3cret&from=id%40example.com',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('aria-invalid="true"');
    expect(wrong.body).not.toContain('s3cret');

    const ok = await a.inject({
      method: 'POST',
      url: '/account/admin/mail',
      headers: post(ADMIN),
      payload: `host=127.0.0.1&port=${smtp.port}&security=none&from=Cenacle+ID+%3Cid%40example.com%3E`,
    });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/account/admin/mail?saved=1');
    expect(JSON.stringify(recorded)).not.toContain('s3cret');
    expect(recorded.at(-1)?.action).toBe('admin.mail_server.changed');

    const test = await a.inject({
      method: 'POST',
      url: '/account/admin/mail/test',
      headers: post(ADMIN),
    });
    expect(test.headers.location).toBe('/account/admin/mail?sent=1');
    expect(smtp.mails.at(-1)).toMatch(/^To: admin@example.com$/m);
    expect(recorded.at(-1)?.action).toBe('admin.mail_server.tested');
  });

  it('only shows a mail server the configuration names', async () => {
    const { a } = await app(valid);
    const page = await a.inject({ url: '/account/admin/mail', headers: as(ADMIN) });
    expect(page.body).toContain('IDP_SMTP_HOST');
    expect(page.body).not.toContain('name="host"');
    const change = await a.inject({
      method: 'POST',
      url: '/account/admin/mail',
      headers: post(ADMIN),
      payload: 'host=other.example.com&port=587&security=starttls&from=a%40b.c',
    });
    expect(change.statusCode).toBe(409);
  });
});
