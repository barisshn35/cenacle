// SPDX-License-Identifier: AGPL-3.0-only
// E-mail Cenacle ID sends (ADR 0057): plain text with a simple HTML alternative,
// in the person's language, with no remote images or tracking.
import { escapeHtml } from '../ui/html.ts';
import type { Locale } from '../ui/messages.ts';
import type { Mail } from './send.ts';

const TEXTS = {
  en: {
    testSubject: 'Cenacle ID test e-mail',
    hello: 'Hello {name},',
    testBody:
      'This is a test e-mail from Cenacle ID at {issuer}. E-mail works: password resets, invitations and sign-in notices can reach people.',
    footer: 'You get this e-mail because an administrator of Cenacle ID asked for it.',
  },
  tr: {
    testSubject: 'Cenacle ID deneme e-postası',
    hello: 'Merhaba {name},',
    testBody:
      'Bu, {issuer} adresindeki Cenacle ID’den gönderilen bir deneme e-postasıdır. E-posta çalışıyor: parola sıfırlama, davet ve oturum açma bildirimleri kişilere ulaşabilir.',
    footer: 'Bu e-postayı Cenacle ID yöneticisi istediği için aldınız.',
  },
} satisfies Record<Locale, Record<string, string>>;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
}

/** Paragraphs as plain text and as minimal, escaped HTML. */
function compose(to: string, subject: string, paragraphs: string[], footer: string): Mail {
  const text = [...paragraphs, '--', footer].join('\n\n') + '\n';
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">` +
    `<div style="max-width:560px">${body}<p style="margin:24px 0 0;font-size:13px;color:#5c5c5c">${escapeHtml(footer)}</p></div></body></html>`;
  return { to, subject, text, html };
}

/** The administrator's test e-mail. */
export function testMail(locale: Locale, to: string, name: string, issuer: string): Mail {
  const t = TEXTS[locale];
  return compose(
    to,
    t.testSubject,
    [fill(t.hello, { name }), fill(t.testBody, { issuer })],
    t.footer,
  );
}
