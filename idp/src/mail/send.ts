// SPDX-License-Identifier: AGPL-3.0-only
// Sends Cenacle ID's e-mail through its mail server (ADR 0057).
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import type { MailServer, MailServerStore } from './server.ts';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** No mail server is set: the caller tells the person what to do instead. */
export class NoMailServer extends Error {
  constructor() {
    super('e-mail is not set up');
    this.name = 'NoMailServer';
  }
}

/** How long a mail server may take at each step. */
const TIMEOUT_MS = 20_000;

function transportOf(s: MailServer) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    // tls: TLS from the start; starttls: required, never in the clear; none: a relay inside the network.
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.username ? { user: s.username, pass: s.password } : undefined,
    // The certificate must be valid for the host name (an address has no server name).
    tls: {
      minVersion: 'TLSv1.2',
      servername: isIP(s.host) ? undefined : s.host,
      rejectUnauthorized: true,
    },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    // Messages come from Cenacle ID's own templates: no files or URLs pulled in.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export class Mailer {
  constructor(private readonly servers: MailServerStore) {}

  /** Whether a mail server is set. */
  async available(): Promise<boolean> {
    return (await this.servers.current()) !== null;
  }

  /** Sends one e-mail; throws NoMailServer without a mail server. */
  async send(mail: Mail): Promise<void> {
    const server = await this.servers.current();
    if (!server) throw new NoMailServer();
    const transport = transportOf(server);
    try {
      await transport.sendMail({
        from: server.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } finally {
      transport.close();
    }
  }
}
