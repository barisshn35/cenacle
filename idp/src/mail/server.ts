// SPDX-License-Identifier: AGPL-3.0-only
// The mail server Cenacle ID sends e-mail through (ADR 0057).
import { isIP } from 'node:net';
import type pg from 'pg';
import { openPrivateKey, sealPrivateKey } from '../keys/crypto.ts';

export type Security = 'starttls' | 'tls' | 'none';

export interface MailServer {
  host: string;
  port: number;
  security: Security;
  username: string;
  password: string;
  /** The sender: an address or "Name <address>". */
  from: string;
}

/** What the admin panel shows: never the password itself. */
export interface MailServerView extends Omit<MailServer, 'password'> {
  hasPassword: boolean;
  /** Named by the configuration (IDP_SMTP_*): shown, not changed in the panel. */
  managed: boolean;
}

/** What an administrator typed; an empty password keeps the saved one. */
export type MailServerInput = MailServer;

export type MailServerProblem = 'host' | 'port' | 'security' | 'clearAccount' | 'username' | 'from';

/** The additional data that binds the sealed password to its row. */
const AAD = 'mail-server';

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+$/;

/** The address of a sender ("Name <a@b>" or "a@b"), or null. */
export function addressOf(from: string): string | null {
  const m = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(from.trim());
  const addr = (m?.[1] ?? m?.[2] ?? '').trim();
  return ADDRESS.test(addr) ? addr : null;
}

/** Checks a mail server as typed; the first problem, or null. An empty host turns e-mail off. */
export function checkMailServer(s: MailServerInput): MailServerProblem | null {
  if (s.host === '') return null;
  const hostName =
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  if (!hostName.test(s.host) && isIP(s.host) === 0) return 'host';
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'port';
  if (!['starttls', 'tls', 'none'].includes(s.security)) return 'security';
  // A password must never travel unencrypted.
  if (s.security === 'none' && s.username !== '') return 'clearAccount';
  if (s.username.length > 320 || s.password.length > 500) return 'username';
  if (s.from.length > 400 || addressOf(s.from) === null) return 'from';
  return null;
}

export class MailServerStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly kek: Buffer,
    /** The one the configuration names, if any. */
    private readonly fixed?: MailServer,
  ) {}

  get managed(): boolean {
    return this.fixed !== undefined;
  }

  /** The mail server to send through, or null when e-mail is off. */
  async current(): Promise<MailServer | null> {
    if (this.fixed) return this.fixed;
    const row = await this.row();
    if (!row || row.host === '') return null;
    return {
      host: row.host,
      port: row.port,
      security: row.security,
      username: row.username,
      password: row.password_enc ? openPrivateKey(this.kek, AAD, row.password_enc) : '',
      from: row.sender,
    };
  }

  async view(): Promise<MailServerView> {
    if (this.fixed) {
      const { password, ...rest } = this.fixed;
      return { ...rest, hasPassword: password !== '', managed: true };
    }
    const row = await this.row();
    return {
      host: row?.host ?? '',
      port: row?.port ?? 587,
      security: row?.security ?? 'starttls',
      username: row?.username ?? '',
      from: row?.sender ?? '',
      hasPassword: !!row?.password_enc,
      managed: false,
    };
  }

  /**
   * Saves a checked mail server. An empty password keeps the saved one; no
   * account (or no host) removes it. Returns whether the password changed.
   */
  async set(s: MailServerInput): Promise<{ passwordChanged: boolean }> {
    if (this.fixed) throw new Error('the configuration names the mail server');
    const before = await this.row();
    const off = s.host === '';
    const keep = s.password === '' && !off && s.username !== '';
    const sealed =
      off || s.username === ''
        ? null
        : keep
          ? (before?.password_enc ?? null)
          : sealPrivateKey(this.kek, AAD, s.password);
    await this.pool.query(
      `INSERT INTO mail_server (id, host, port, security, username, password_enc, sender, updated_at)
       VALUES (true, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET host = $1, port = $2, security = $3, username = $4,
         password_enc = $5, sender = $6, updated_at = now()`,
      off
        ? ['', 587, 'starttls', '', null, '']
        : [s.host, s.port, s.security, s.username, sealed, s.from.trim()],
    );
    const had = !!before?.password_enc;
    return { passwordChanged: keep ? false : had || sealed !== null };
  }

  private async row() {
    const { rows } = await this.pool.query<{
      host: string;
      port: number;
      security: Security;
      username: string;
      password_enc: Buffer | null;
      sender: string;
    }>('SELECT host, port, security, username, password_enc, sender FROM mail_server');
    return rows[0];
  }
}
