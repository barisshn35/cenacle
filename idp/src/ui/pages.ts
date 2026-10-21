// SPDX-License-Identifier: Apache-2.0
import { html, raw, type SafeHtml } from './html.ts';
import { format, LOCALES, MESSAGES, type Locale } from './messages.ts';

/** Query parameter that switches the page language (remembered in a cookie). */
export const LANG_PARAM = 'lang';

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe' };

const button =
  'inline-flex min-h-target min-w-target h-10 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-input bg-background hover:bg-muted`;
const input =
  'block min-h-target h-10 w-full rounded-lg border border-input bg-background px-3 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';
const label = 'text-sm font-medium';

// Own artwork: a rounded square with an exclamation mark (no icon library needed).
const alertIcon = raw(
  '<svg aria-hidden="true" viewBox="0 0 16 16" class="mt-0.5 size-4 shrink-0 fill-none stroke-current text-destructive" stroke-width="1.75" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.75v3.75M8 11.25v.01"/></svg>',
);
// Cenacle icon (logo pack, direction B); colours follow the theme tokens.
const logo = raw(
  '<svg aria-hidden="true" viewBox="0 0 48 48" class="size-9 shrink-0"><path fill="none" stroke="var(--logo-ink)" stroke-width="6.5" stroke-linecap="round" d="M10 41V22A14 14 0 0 1 38 22V41"/><path fill="var(--logo-accent)" d="M17.5 33V25.5A5.5 5.5 0 0 1 23 20H25A5.5 5.5 0 0 1 30.5 25.5V27.5A5.5 5.5 0 0 1 25 33Z"/></svg>',
);

interface LayoutOptions {
  locale: Locale;
  title: string;
  body: SafeHtml;
  /** Path (without query) used for the language links; omit to hide them. */
  languagePath?: string;
}

export function layout({ locale, title, body, languagePath }: LayoutOptions): string {
  const m = MESSAGES[locale];
  const languages = languagePath
    ? html`<nav aria-label="${m.language}" class="flex justify-center gap-1 text-sm">
        ${LOCALES.map((l) =>
          l === locale
            ? html`<span
                aria-current="true"
                class="inline-flex min-h-target items-center rounded-md px-3 font-medium"
                lang="${l}"
                >${LANGUAGE_NAMES[l]}</span
              >`
            : html`<a
                href="${languagePath}?${LANG_PARAM}=${l}"
                hreflang="${l}"
                lang="${l}"
                class="inline-flex min-h-target items-center rounded-md px-3 text-muted-foreground underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
                >${LANGUAGE_NAMES[l]}</a
              >`,
        )}
      </nav>`
    : null;

  return `<!doctype html>${html`<html lang="${locale}">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <meta name="referrer" content="same-origin" />
      <title>${title} · ${m.productName}</title>
      <link rel="stylesheet" href="/assets/cenacle-id.css" />
      <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
      <script src="/assets/theme.js"></script>
    </head>
    <body class="min-h-svh bg-background text-foreground antialiased">
      <a
        href="#main"
        class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:inline-flex focus:min-h-target focus:items-center focus:rounded-md focus:bg-background focus:px-3 focus:ring-3 focus:ring-ring/50 focus:outline-none"
        >${m.skipToContent}</a
      >
      <div class="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-8 px-4 py-10">
        <header class="flex items-center gap-3">
          ${logo}
          <span class="text-lg font-semibold">${m.productName}</span>
        </header>
        <main id="main" class="flex flex-col gap-6">${body}</main>
        <footer>${languages}</footer>
      </div>
    </body>
  </html>`}`;
}

function alertBox(id: string, title: string, action?: string): SafeHtml {
  return html`<div
    id="${id}"
    role="alert"
    class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm"
  >
    ${alertIcon}
    <p><span class="font-medium">${title}</span>${action ? html` ${action}` : null}</p>
  </div>`;
}

export type LoginError = 'invalid' | 'missing' | { rateLimited: number };

export function loginPage(opts: {
  locale: Locale;
  uid: string;
  clientName: string;
  email?: string;
  error?: LoginError;
}): string {
  const m = MESSAGES[opts.locale].login;
  const errorId = 'login-error';
  let error: SafeHtml | null = null;
  if (opts.error === 'invalid') error = alertBox(errorId, m.invalid, m.invalidAction);
  else if (opts.error === 'missing') error = alertBox(errorId, m.missing);
  else if (opts.error)
    error = alertBox(
      errorId,
      m.rateLimited,
      format(m.rateLimitedAction, { seconds: opts.error.rateLimited }),
    );
  const invalid = opts.error === 'invalid' || opts.error === 'missing';
  const describedBy = error ? errorId : undefined;

  const body = html`<div class="flex flex-col gap-1">
      <h1 class="font-display text-3xl font-medium">${m.title}</h1>
      <p class="text-sm text-muted-foreground">
        ${format(m.subtitle, { client: opts.clientName })}
      </p>
    </div>
    ${error}
    <form method="post" action="/interaction/${opts.uid}/login" class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <label for="email" class="${label}">${m.email}</label>
        <input
          id="email"
          name="email"
          type="email"
          inputmode="email"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          required
          maxlength="320"
          value="${opts.email ?? ''}"
          class="${input}"
          ${raw(opts.email ? '' : 'autofocus')}
          ${raw(invalid ? 'aria-invalid="true"' : '')}
          ${describedBy ? raw(`aria-describedby="${describedBy}"`) : null}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <label for="password" class="${label}">${m.password}</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="1024"
          class="${input}"
          ${raw(opts.email ? 'autofocus' : '')}
          ${raw(invalid ? 'aria-invalid="true"' : '')}
          ${describedBy ? raw(`aria-describedby="${describedBy}"`) : null}
        />
      </div>
      <button type="submit" class="${primary}">${m.submit}</button>
    </form>
    <form method="post" action="/interaction/${opts.uid}/abort">
      <button type="submit" class="${secondary}">${m.cancel}</button>
    </form>`;
  return layout({
    locale: opts.locale,
    title: m.title,
    body,
    languagePath: `/interaction/${opts.uid}`,
  });
}

export function errorPage(opts: {
  locale: Locale;
  code: string;
  requestId?: string;
  unsupportedClient?: boolean;
}): string {
  const m = MESSAGES[opts.locale].error;
  const body = html`<div role="alert" class="flex flex-col gap-3">
    <h1 class="text-2xl font-semibold">${m.title}</h1>
    <p class="text-muted-foreground">${opts.unsupportedClient ? m.unsupported : m.reason}</p>
    <p>${m.action}</p>
    <dl class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <div class="flex gap-1">
        <dt>${m.code}:</dt>
        <dd class="font-mono select-all">${opts.code}</dd>
      </div>
      ${
        opts.requestId
          ? html`<div class="flex gap-1">
              <dt>${m.requestId}:</dt>
              <dd class="font-mono select-all">${opts.requestId}</dd>
            </div>`
          : null
      }
    </dl>
  </div>`;
  return layout({ locale: opts.locale, title: m.title, body });
}

/** RP-initiated logout confirmation; `form` is the provider's hidden logout form. */
export function logoutPage(opts: { locale: Locale; form: string }): string {
  const m = MESSAGES[opts.locale].logout;
  const body = html`<div class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold">${m.title}</h1>
      <p class="text-muted-foreground">${m.body}</p>
    </div>
    ${raw(opts.form)}
    <div class="flex flex-col gap-3">
      <button
        type="submit"
        form="op.logoutForm"
        name="logout"
        value="yes"
        class="${primary}"
        autofocus
      >
        ${m.confirm}
      </button>
      <button type="submit" form="op.logoutForm" class="${secondary}">${m.stay}</button>
    </div>`;
  return layout({ locale: opts.locale, title: m.title, body });
}

export function loggedOutPage(opts: { locale: Locale }): string {
  const m = MESSAGES[opts.locale].logout;
  const body = html`<div role="status" class="flex flex-col gap-2">
    <h1 class="text-2xl font-semibold">${m.doneTitle}</h1>
    <p class="text-muted-foreground">${m.doneBody}</p>
  </div>`;
  return layout({ locale: opts.locale, title: m.doneTitle, body });
}
