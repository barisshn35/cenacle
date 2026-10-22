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
  /** Wide pages (the admin panel) instead of the narrow sign-in column. */
  wide?: boolean;
  /** The page uses passkeys (WebAuthn): load their scripts. */
  passkeys?: boolean;
  /** Go on to this same-origin path at once (a navigation of our own page). */
  refreshTo?: string;
}

export function layout({
  locale,
  title,
  body,
  languagePath,
  wide,
  passkeys,
  refreshTo,
}: LayoutOptions): string {
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
      ${refreshTo ? html`<meta http-equiv="refresh" content="0; url=${refreshTo}" />` : null}
      <title>${title} · ${m.productName}</title>
      <link rel="stylesheet" href="/assets/cenacle-id.css" />
      <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
      <script src="/assets/theme.js"></script>
      ${
        passkeys
          ? html`<script src="/assets/simplewebauthn.js" defer></script>
              <script src="/assets/passkey.js" defer></script>`
          : null
      }
    </head>
    <body class="min-h-svh bg-background text-foreground antialiased">
      <a
        href="#main"
        class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:inline-flex focus:min-h-target focus:items-center focus:rounded-md focus:bg-background focus:px-3 focus:ring-3 focus:ring-ring/50 focus:outline-none"
        >${m.skipToContent}</a
      >
      <div
        class="${
          wide
            ? 'mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-8 px-4 py-8'
            : 'mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-8 px-4 py-10'
        }"
      >
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

export function alertBox(id: string, title: string, action?: string): SafeHtml {
  return html`<div
    id="${id}"
    role="alert"
    class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm"
  >
    ${alertIcon}
    <p><span class="font-medium">${title}</span>${action ? html` ${action}` : null}</p>
  </div>`;
}

export type LoginError =
  'invalid' | 'missing' | 'unavailable' | 'passkey' | 'federation' | { rateLimited: number };

export function loginPage(opts: {
  locale: Locale;
  uid: string;
  clientName: string;
  email?: string;
  error?: LoginError;
  /** A directory is connected: people may sign in with their username. */
  usernames?: boolean;
  /** Identity providers people may sign in with instead. */
  providers?: { id: string; name: string }[];
}): string {
  const m = MESSAGES[opts.locale].login;
  return credentialsPage({
    ...opts,
    providerLinks: (opts.providers ?? []).map((p) => ({
      name: p.name,
      href: `/federation/${p.id}/start?interaction=${encodeURIComponent(opts.uid)}`,
    })),
    title: m.title,
    subtitle: format(m.subtitle, { client: opts.clientName }),
    action: `/interaction/${opts.uid}/login`,
    cancelAction: `/interaction/${opts.uid}/abort`,
    languagePath: `/interaction/${opts.uid}`,
    passkey: `/interaction/${opts.uid}/passkey`,
  });
}

/** Sign-in to the account pages (outside an app's sign-in). */
export function accountSigninPage(opts: {
  locale: Locale;
  email?: string;
  error?: LoginError;
  notice?: string;
  usernames?: boolean;
  providers?: { id: string; name: string }[];
}): string {
  const m = MESSAGES[opts.locale].account;
  return credentialsPage({
    ...opts,
    providerLinks: (opts.providers ?? []).map((p) => ({
      name: p.name,
      href: `/federation/${p.id}/start?purpose=account`,
    })),
    title: m.signinTitle,
    subtitle: m.signinSubtitle,
    action: '/account/signin',
    languagePath: '/account',
    passkey: '/account/passkey',
  });
}

function credentialsPage(opts: {
  locale: Locale;
  title: string;
  subtitle: string;
  action: string;
  cancelAction?: string;
  languagePath: string;
  /** Where a passkey sign-in posts (its options at `${passkey}/options`). */
  passkey: string;
  providerLinks: { name: string; href: string }[];
  email?: string;
  error?: LoginError;
  notice?: string;
  usernames?: boolean;
}): string {
  const m = MESSAGES[opts.locale].login;
  const errorId = 'login-error';
  let error: SafeHtml | null = null;
  if (opts.error === 'invalid')
    error = alertBox(errorId, opts.usernames ? m.invalidIdentifier : m.invalid, m.invalidAction);
  else if (opts.error === 'missing')
    error = alertBox(errorId, opts.usernames ? m.missingIdentifier : m.missing);
  else if (opts.error === 'unavailable')
    error = alertBox(errorId, m.unavailable, m.unavailableAction);
  else if (opts.error === 'passkey')
    error = alertBox(errorId, m.passkeyFailed, m.passkeyFailedAction);
  else if (opts.error === 'federation')
    error = alertBox(errorId, m.federationFailed, m.federationFailedAction);
  else if (opts.error)
    error = alertBox(
      errorId,
      m.rateLimited,
      format(m.rateLimitedAction, { seconds: opts.error.rateLimited }),
    );
  const invalid = opts.error === 'invalid' || opts.error === 'missing';
  const describedBy = error ? errorId : undefined;

  const body = html`<div class="flex flex-col gap-1">
      <h1 class="font-display text-3xl font-medium">${opts.title}</h1>
      <p class="text-sm text-muted-foreground">${opts.subtitle}</p>
    </div>
    ${opts.notice ? noticeBox(opts.notice) : null} ${error}
    <form method="post" action="${opts.action}" class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <label for="email" class="${label}">${opts.usernames ? m.identifier : m.email}</label>
        <input
          id="email"
          name="email"
          type="${opts.usernames ? 'text' : 'email'}"
          inputmode="${opts.usernames ? 'text' : 'email'}"
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
    ${alternatives({
      passkey: opts.passkey,
      providers: opts.providerLinks,
      text: m.passkey,
      continueWith: m.continueWith,
      or: m.or,
      cancelled: m.passkeyCancelled,
      failed: `${m.passkeyFailed} ${m.passkeyFailedAction}`,
    })}
    ${
      opts.cancelAction
        ? html`<form method="post" action="${opts.cancelAction}">
            <button type="submit" class="${secondary}">${m.cancel}</button>
          </form>`
        : null
    }`;
  return layout({
    locale: opts.locale,
    title: opts.title,
    body,
    languagePath: opts.languagePath,
    passkeys: true,
  });
}

// Own artwork: a key (no icon library needed).
const keyIcon = raw(
  '<svg aria-hidden="true" viewBox="0 0 16 16" class="size-4 shrink-0 fill-none stroke-current" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="10.5" r="3"/><path d="m7.6 8.4 6-6M11.5 4.5l1.5 1.5M10 6l1 1"/></svg>',
);

/**
 * Other ways to sign in, below the password: a passkey (shown by passkey.js
 * where the browser supports WebAuthn; it fetches the options, asks the
 * browser and posts the answer with the form) and identity providers.
 */
function alternatives(o: {
  passkey: string;
  providers: { name: string; href: string }[];
  text: string;
  continueWith: string;
  or: string;
  cancelled: string;
  failed: string;
}): SafeHtml {
  // Without providers the block shows only where passkeys work.
  const onlyPasskey = o.providers.length === 0;
  return html`<div
    class="flex flex-col gap-3"
    ${onlyPasskey ? raw('data-passkey-block hidden') : null}
  >
    <p class="flex items-center gap-3 text-xs text-muted-foreground uppercase">
      <span aria-hidden="true" class="h-px flex-1 bg-border"></span>${o.or}<span
        aria-hidden="true"
        class="h-px flex-1 bg-border"
      ></span>
    </p>
    <form id="passkey-form" method="post" action="${o.passkey}" data-passkey-block hidden>
      <input type="hidden" name="challenge" />
      <input type="hidden" name="response" />
      <button
        type="button"
        class="${secondary}"
        data-passkey="signin"
        data-options="${o.passkey}/options"
        data-status="passkey-status"
      >
        ${keyIcon}${o.text}
      </button>
    </form>
    ${o.providers.map(
      (p) =>
        html`<a href="${p.href}" class="${secondary}" data-testid="provider"
          >${format(o.continueWith, { provider: p.name })}</a
        >`,
    )}
    <p
      id="passkey-status"
      aria-live="polite"
      class="text-sm text-muted-foreground"
      data-cancelled="${o.cancelled}"
      data-failed="${o.failed}"
    ></p>
  </div>`;
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

export function noticeBox(text: string): SafeHtml {
  return html`<p role="status" class="rounded-lg border px-3 py-2.5 text-sm">${text}</p>`;
}

export type CodeError = { attemptsLeft: number } | 'invalid' | 'expired';

/** One field for a TOTP or recovery code; paste allowed (WCAG 3.3.8). */
function codeField(locale: Locale, error: CodeError | undefined, describedBy: string | undefined) {
  const m = MESSAGES[locale].mfa;
  return html`<div class="flex flex-col gap-1.5">
    <label for="code" class="${label}">${m.code}</label>
    <input
      id="code"
      name="code"
      type="text"
      inputmode="text"
      autocomplete="one-time-code"
      autocapitalize="none"
      spellcheck="false"
      required
      maxlength="32"
      class="${input} font-mono tracking-wider"
      autofocus
      ${raw(error ? 'aria-invalid="true"' : '')}
      aria-describedby="${describedBy ? `${describedBy} code-hint` : 'code-hint'}"
    />
    <p id="code-hint" class="text-xs text-muted-foreground">${m.codeHint}</p>
  </div>`;
}

function codeError(locale: Locale, error: CodeError | undefined): SafeHtml | null {
  const m = MESSAGES[locale].mfa;
  if (!error) return null;
  if (error === 'expired') return alertBox('code-error', m.expired, m.expiredAction);
  if (error === 'invalid') return alertBox('code-error', m.invalid, m.invalidShort);
  return alertBox(
    'code-error',
    m.invalid,
    format(m.invalidAction, { attempts: error.attemptsLeft }),
  );
}

/** The second step of a sign-in: a code from the app or a recovery code. */
export function secondStepPage(opts: {
  locale: Locale;
  action: string;
  cancelAction?: string;
  languagePath?: string;
  challenge?: string;
  error?: CodeError;
}): string {
  const m = MESSAGES[opts.locale].mfa;
  const error = codeError(opts.locale, opts.error);
  const body = html`<div class="flex flex-col gap-1">
      <h1 class="font-display text-3xl font-medium">${m.title}</h1>
      <p class="text-sm text-muted-foreground">${m.subtitle}</p>
    </div>
    ${error}
    ${
      opts.error === 'expired'
        ? null
        : html`<form method="post" action="${opts.action}" class="flex flex-col gap-4">
            ${
              opts.challenge
                ? html`<input type="hidden" name="challenge" value="${opts.challenge}" />`
                : null
            }
            ${codeField(opts.locale, opts.error, error ? 'code-error' : undefined)}
            <p class="text-sm text-muted-foreground">${m.lostDevice}</p>
            <button type="submit" class="${primary}">${m.submit}</button>
          </form>`
    }
    ${
      opts.cancelAction
        ? html`<form method="post" action="${opts.cancelAction}">
            <button type="submit" class="${secondary}">${m.cancel}</button>
          </form>`
        : null
    }`;
  return layout({ locale: opts.locale, title: m.title, body, languagePath: opts.languagePath });
}

export interface AccountView {
  name: string;
  email: string;
  twoStep: boolean;
  recoveryLeft: number;
  events: { at: Date; action: string; ip: string }[];
  returnTo?: string;
  notice?: string;
  /** Administers Cenacle ID: show the way to the admin panel. */
  isAdmin?: boolean;
  passkeys: {
    id: string;
    name: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    synced: boolean;
  }[];
  /** Why adding a passkey failed, if it just did. */
  passkeyError?: 'failed' | 'limit';
  /** The name can be changed here (local accounts). */
  nameEditable?: boolean;
  nameInvalid?: boolean;
}

/** The account page: two-step verification and recent activity. */
export function accountPage(opts: { locale: Locale } & AccountView): string {
  const m = MESSAGES[opts.locale].account;
  const when = new Intl.DateTimeFormat(opts.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const body = html`<div class="flex flex-col gap-1">
      <h1 class="font-display text-3xl font-medium">${m.title}</h1>
      <p class="text-sm text-muted-foreground">${opts.name} · ${opts.email}</p>
    </div>
    ${opts.notice ? noticeBox(opts.notice) : null}
    ${
      opts.nameEditable
        ? html`<section aria-labelledby="profile" class="flex flex-col gap-3 rounded-xl border p-4">
            <h2 id="profile" class="font-semibold">${m.profile}</h2>
            ${opts.nameInvalid ? alertBox('name-error', m.nameInvalid) : null}
            <form method="post" action="/account/name" class="flex flex-col gap-3">
              <div class="flex flex-col gap-1.5">
                <label for="display-name" class="${label}">${m.displayName}</label>
                <input
                  id="display-name"
                  name="name"
                  required
                  maxlength="100"
                  autocomplete="name"
                  value="${opts.name}"
                  class="${input}"
                  ${raw(opts.nameInvalid ? 'aria-invalid="true" aria-describedby="name-error"' : '')}
                />
              </div>
              <button type="submit" class="${secondary}">${m.saveName}</button>
            </form>
          </section>`
        : null
    }
    <section aria-labelledby="two-step" class="flex flex-col gap-3 rounded-xl border p-4">
      <h2 id="two-step" class="font-semibold">${m.twoStep}</h2>
      <p class="text-sm" data-testid="two-step-state">
        ${opts.twoStep ? m.twoStepOn : m.twoStepOff}
      </p>
      ${
        opts.twoStep
          ? html`<p class="text-sm text-muted-foreground">
                ${format(m.recoveryLeft, { count: opts.recoveryLeft })}
              </p>
              <a href="/account/recovery-codes" class="${secondary}">${m.newCodes}</a>
              <a href="/account/two-step/off" class="${secondary}">${m.turnOff}</a>`
          : html`<a href="/account/two-step/setup" class="${primary}">${m.setUp}</a>`
      }
    </section>
    <section aria-labelledby="passkeys" class="flex flex-col gap-3 rounded-xl border p-4">
      <h2 id="passkeys" class="font-semibold">${m.passkeys}</h2>
      <p class="text-sm text-muted-foreground">${m.passkeysBody}</p>
      ${
        opts.passkeyError
          ? alertBox(
              'passkey-error',
              opts.passkeyError === 'limit' ? m.passkeyLimit : m.passkeyFailed,
              opts.passkeyError === 'limit' ? undefined : m.passkeyFailedAction,
            )
          : null
      }
      ${
        opts.passkeys.length === 0
          ? html`<p class="text-sm" data-testid="no-passkeys">${m.noPasskeys}</p>`
          : html`<ul
              class="flex flex-col divide-y rounded-lg border text-sm"
              data-testid="passkeys"
            >
              ${opts.passkeys.map(
                (p) =>
                  html`<li class="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate font-medium">${p.name}</span>
                      <span class="text-xs text-muted-foreground"
                        >${format(m.passkeyCreated, { date: when.format(p.createdAt) })}${
                          p.lastUsedAt
                            ? html` · ${format(m.passkeyUsed, { date: when.format(p.lastUsedAt) })}`
                            : null
                        }${p.synced ? html` · ${m.passkeySynced}` : null}</span
                      >
                    </div>
                    <form
                      method="post"
                      action="/account/passkeys/${encodeURIComponent(p.id)}/delete"
                    >
                      <button
                        type="submit"
                        class="inline-flex min-h-target items-center rounded-md px-3 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                        aria-label="${format(m.removePasskey, { name: p.name })}"
                      >
                        ${m.remove}
                      </button>
                    </form>
                  </li>`,
              )}
            </ul>`
      }
      <form
        id="passkey-add"
        method="post"
        action="/account/passkeys"
        data-passkey-block
        hidden
        class="flex flex-col gap-3"
      >
        <input type="hidden" name="challenge" />
        <input type="hidden" name="response" />
        <div class="flex flex-col gap-1.5">
          <label for="passkey-name" class="${label}">${m.passkeyName}</label>
          <input
            id="passkey-name"
            name="name"
            required
            maxlength="80"
            autocomplete="off"
            aria-describedby="passkey-name-hint"
            class="${input}"
          />
          <p id="passkey-name-hint" class="text-xs text-muted-foreground">${m.passkeyNameHint}</p>
        </div>
        <button
          type="button"
          class="${secondary}"
          data-passkey="register"
          data-options="/account/passkeys/options"
          data-status="passkey-add-status"
        >
          ${keyIcon}${m.addPasskey}
        </button>
        <p
          id="passkey-add-status"
          aria-live="polite"
          class="text-sm text-muted-foreground"
          data-cancelled="${m.passkeyCancelled}"
          data-failed="${m.passkeyFailed} ${m.passkeyFailedAction}"
        ></p>
      </form>
    </section>
    <section aria-labelledby="activity" class="flex flex-col gap-2">
      <h2 id="activity" class="font-semibold">${m.activity}</h2>
      ${
        opts.events.length === 0
          ? html`<p class="text-sm text-muted-foreground">${m.noActivity}</p>`
          : html`<ul class="flex flex-col divide-y rounded-xl border text-sm">
              ${opts.events.map(
                (e) =>
                  html`<li class="flex flex-col gap-0.5 px-3 py-2">
                    <span>${m.actions[e.action] ?? e.action}</span>
                    <span class="text-xs text-muted-foreground"
                      ><time datetime="${e.at.toISOString()}">${when.format(e.at)}</time>${
                        e.ip ? html` · ${e.ip}` : null
                      }</span
                    >
                  </li>`,
              )}
            </ul>`
      }
    </section>
    <div class="flex flex-col gap-3">
      ${opts.returnTo ? html`<a href="${opts.returnTo}" class="${primary}">${m.back}</a>` : null}
      ${opts.isAdmin ? html`<a href="/account/admin" class="${secondary}">${m.administration}</a>` : null}
      <form method="post" action="/account/signout">
        <button type="submit" class="${secondary}">${m.signOut}</button>
      </form>
    </div>`;
  return layout({
    locale: opts.locale,
    title: m.title,
    body,
    languagePath: '/account',
    passkeys: true,
  });
}

/** Setting up TOTP: QR code, the key for typing in, and the first code. */
export function setupPage(opts: {
  locale: Locale;
  secret: string;
  qrSvg: string;
  error?: CodeError;
}): string {
  const m = MESSAGES[opts.locale].account;
  const error = codeError(opts.locale, opts.error);
  // The key in groups of four, easier to type.
  const grouped = opts.secret.replace(/(.{4})/g, '$1 ').trim();
  const body = html`<h1 class="font-display text-3xl font-medium">${m.setupTitle}</h1>
    <ol class="flex list-decimal flex-col gap-4 pl-5 text-sm">
      <li class="flex flex-col gap-3">
        <span>${m.setupStep1}</span>
        <figure
          role="img"
          aria-label="${m.qrLabel}"
          class="w-48 self-center rounded-lg bg-white p-2 [&>svg]:h-auto [&>svg]:w-full"
        >
          ${raw(opts.qrSvg)}
        </figure>
      </li>
      <li class="flex flex-col gap-1.5">
        <span>${m.setupStep2}</span>
        <code
          data-testid="totp-secret"
          class="rounded-md bg-muted px-2 py-1.5 font-mono text-sm break-all select-all"
          >${grouped}</code
        >
      </li>
      <li>${m.setupStep3}</li>
    </ol>
    ${error}
    <form method="post" action="/account/two-step/setup" class="flex flex-col gap-4">
      ${codeField(opts.locale, opts.error, error ? 'code-error' : undefined)}
      <button type="submit" class="${primary}">${m.confirm}</button>
    </form>
    <a href="/account" class="${secondary}">${m.cancel}</a>`;
  return layout({ locale: opts.locale, title: m.setupTitle, body });
}

/** Recovery codes, shown once. */
export function recoveryCodesPage(opts: { locale: Locale; codes: string[] }): string {
  const m = MESSAGES[opts.locale].account;
  const body = html`<div class="flex flex-col gap-2">
      <h1 class="font-display text-3xl font-medium">${m.codesTitle}</h1>
      <p class="text-sm text-muted-foreground">${m.codesBody}</p>
    </div>
    <ul
      data-testid="recovery-codes"
      class="grid grid-cols-2 gap-2 rounded-xl border p-4 font-mono text-sm select-all"
    >
      ${opts.codes.map((c) => html`<li>${c}</li>`)}
    </ul>
    <a href="/account" class="${primary}">${m.codesDone}</a>`;
  return layout({ locale: opts.locale, title: m.codesTitle, body });
}

/** Confirms a security change with a current code (turning off, new recovery codes). */
export function confirmWithCodePage(opts: {
  locale: Locale;
  title: string;
  body: string;
  confirm: string;
  action: string;
  destructive?: boolean;
  error?: CodeError;
}): string {
  const m = MESSAGES[opts.locale].account;
  const error = codeError(opts.locale, opts.error);
  const body = html`<div class="flex flex-col gap-2">
      <h1 class="font-display text-3xl font-medium">${opts.title}</h1>
      <p class="text-sm text-muted-foreground">${opts.body}</p>
    </div>
    ${error}
    <form method="post" action="${opts.action}" class="flex flex-col gap-4">
      ${codeField(opts.locale, opts.error, error ? 'code-error' : undefined)}
      <button
        type="submit"
        class="${
          opts.destructive ? `${button} bg-destructive text-white hover:bg-destructive/90` : primary
        }"
      >
        ${opts.confirm}
      </button>
    </form>
    <a href="/account" class="${secondary}">${m.cancel}</a>`;
  return layout({ locale: opts.locale, title: opts.title, body });
}

/**
 * After signing in at another provider: the way back to the account page.
 * The browser arrives here from the provider's site, so the account cookie
 * (SameSite=Strict) only goes along once our own page navigates on.
 */
export function continuePage(opts: { locale: Locale; to: string }): string {
  const m = MESSAGES[opts.locale].account;
  return layout({
    locale: opts.locale,
    title: m.title,
    refreshTo: opts.to,
    body: html`<a href="${opts.to}" class="${primary}">${m.continue}</a>`,
  });
}
