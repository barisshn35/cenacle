// SPDX-License-Identifier: AGPL-3.0-only
import { html, raw, type SafeHtml } from './html.ts';
import { directionOf, format, LOCALES, MESSAGES, type Locale } from './messages.ts';

/** Query parameter that switches the page language (remembered in a cookie). */
export const LANG_PARAM = 'lang';

const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
};

const button =
  'inline-flex min-h-target min-w-target h-11 w-full items-center justify-center gap-2 rounded-[10px] px-4 text-[14.5px] font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';
const primary = `${button} h-12 bg-primary text-[15.5px] font-semibold text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-rule-strong bg-background hover:bg-muted`;
const input =
  'block min-h-target h-11 w-full rounded-[10px] border border-rule-strong bg-background px-3.5 text-[15px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';
const label = 'text-[13.5px] font-semibold';
const textLink =
  'inline-flex min-h-target items-center rounded-sm underline underline-offset-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50';
const heading = 'text-[34px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance';
const lede = 'mt-2 text-[15.5px] leading-[1.55] text-muted-foreground';

// Own artwork: a rounded square with an exclamation mark (no icon library needed).
const alertIcon = raw(
  '<svg aria-hidden="true" viewBox="0 0 16 16" class="mt-0.5 size-4 shrink-0 fill-none stroke-current text-destructive" stroke-width="1.75" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.75v3.75M8 11.25v.01"/></svg>',
);
// Shield with a check and a padlock, after lucide's shield-check and lock (ISC).
const shieldIcon = raw(
  '<svg aria-hidden="true" viewBox="0 0 24 24" class="size-4 shrink-0 fill-none stroke-current" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
);
const lockIcon = raw(
  '<svg aria-hidden="true" viewBox="0 0 24 24" class="mt-0.5 size-4 shrink-0 fill-none stroke-current" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
);
const checkIcon = raw(
  '<svg aria-hidden="true" viewBox="0 0 24 24" class="size-3.5 fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
);
// Cenacle icon (logo pack, direction B); colours follow the theme tokens.
const logo = raw(
  '<svg aria-hidden="true" viewBox="0 0 48 48" class="size-[30px] shrink-0"><path fill="none" stroke="var(--logo-ink)" stroke-width="6.5" stroke-linecap="round" d="M10 41V22A14 14 0 0 1 38 22V41"/><path fill="var(--logo-accent)" d="M17.5 33V25.5A5.5 5.5 0 0 1 23 20H25A5.5 5.5 0 0 1 30.5 25.5V27.5A5.5 5.5 0 0 1 25 33Z"/></svg>',
);

/** The address of this Cenacle ID (from its issuer), named on the sign-in pages. */
let pageHost = '';

/** The operator's privacy policy, linked at the foot of every page; empty: no link. */
let privacyUrl = '';

/** Sets what the pages say about this server; called once at start-up. */
export function configurePages(opts: { issuer: string; privacyUrl?: string }): void {
  privacyUrl = opts.privacyUrl ?? '';
  try {
    pageHost = new URL(opts.issuer).host;
  } catch {
    pageHost = '';
  }
}

/** Where a sign-in stands, shown beside its pages as a record. */
export interface SigninProgress {
  /** The app being signed in to; omitted for the account pages. */
  client?: string;
  step: 1 | 2 | 3;
  /** The account, once known (step 2 and later). */
  account?: string;
  /** Setting up two-step verification rather than entering a code. */
  setup?: boolean;
}

function signinRecord(locale: Locale, p: SigninProgress): SafeHtml {
  const m = MESSAGES[locale].record;
  const target = p.client ?? m.accountPages;
  const step = (n: 1 | 2 | 3, text: string, note: string) => {
    const state = p.step > n ? 'done' : p.step === n ? 'current' : 'todo';
    return html`<li
      class="grid grid-cols-[24px_1fr_auto] items-center gap-2.5 text-sm ${
        state === 'current' ? 'font-semibold' : state === 'todo' ? 'text-muted-foreground' : ''
      }"
      ${state === 'current' ? raw('aria-current="step"') : null}
    >
      <span
        aria-hidden="true"
        class="grid size-6 place-items-center rounded-full border text-xs tabular-nums ${
          state === 'done'
            ? 'border-well bg-well text-success'
            : state === 'current'
              ? 'border-foreground text-foreground'
              : 'border-rule-strong text-muted-foreground'
        }"
        >${state === 'done' ? checkIcon : String(n)}</span
      >
      <span
        >${text}${state === 'done' ? html`<span class="sr-only"> (${m.done})</span>` : null}</span
      >
      <small class="text-xs font-normal text-muted-foreground">${note}</small>
    </li>`;
  };
  return html`<aside
    aria-label="${m.title}"
    class="overflow-hidden rounded-[10px] border border-rule-strong bg-background"
  >
    <h2
      class="flex items-center gap-2 border-b border-rule-strong px-4 py-3 text-[13px] font-semibold"
    >
      <span class="text-muted-foreground">${shieldIcon}</span>${m.title}
    </h2>
    <dl>
      <div class="grid gap-0.5 px-4 pt-2.5 pb-3">
        <dt class="text-[11.5px] text-muted-foreground">${m.signingInTo}</dt>
        <dd class="text-sm">${target}</dd>
      </div>
      ${
        pageHost
          ? html`<div class="grid gap-0.5 border-t px-4 pt-2.5 pb-3">
              <dt class="text-[11.5px] text-muted-foreground">${m.thisPage}</dt>
              <dd class="text-[13.5px]" data-testid="page-host">${pageHost}</dd>
            </div>`
          : null
      }
    </dl>
    <div class="grid gap-2.5 border-t border-rule-strong px-4 pt-3 pb-3.5">
      <h3 class="text-[11.5px] font-medium text-muted-foreground">${m.steps}</h3>
      <ol class="grid gap-2.5">
        ${step(1, m.account, p.step > 1 && p.account ? p.account : '')}
        ${step(2, p.setup ? m.setUpSecondStep : m.secondStep, p.step === 2 ? m.authenticator : m.ifOn)}
        ${step(3, p.client ? format(m.back, { client: p.client }) : m.backAccount, '')}
      </ol>
    </div>
    ${
      pageHost
        ? html`<p
            class="flex gap-2 border-t border-rule-strong px-4 py-2.5 text-[13px] leading-5 text-muted-foreground"
          >
            ${lockIcon}<span>${format(m.note, { host: pageHost })}</span>
          </p>`
        : null
    }
  </aside>`;
}

interface LayoutOptions {
  locale: Locale;
  title: string;
  body: SafeHtml;
  /** Path (without query) used for the language links; omit to hide them. */
  languagePath?: string;
  /** Wide pages (the account and admin pages) instead of the sign-in column. */
  wide?: boolean;
  /** A step of a sign-in: shown beside the form as a record. */
  signin?: SigninProgress;
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
  signin,
  passkeys,
  refreshTo,
}: LayoutOptions): string {
  const m = MESSAGES[locale];
  const languages = languagePath
    ? html`<nav aria-label="${m.language}" class="flex flex-wrap gap-1 text-sm">
        ${LOCALES.map((l) =>
          l === locale
            ? html`<span
                aria-current="true"
                class="inline-flex min-h-target items-center rounded-[7px] border border-rule-strong bg-background px-3 font-medium"
                lang="${l}"
                >${LANGUAGE_NAMES[l]}</span
              >`
            : html`<a
                href="${languagePath}?${LANG_PARAM}=${l}"
                hreflang="${l}"
                lang="${l}"
                class="inline-flex min-h-target items-center rounded-[7px] px-3 text-muted-foreground underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
                >${LANGUAGE_NAMES[l]}</a
              >`,
        )}
      </nav>`
    : null;

  const main = wide
    ? html`<main
        id="main"
        class="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-8 px-4 pt-4 pb-10 sm:px-10"
      >
        ${body}
      </main>`
    : html`<main
        id="main"
        class="grid content-start items-center justify-center gap-10 px-4 pt-6 pb-10 sm:px-10 ${
          signin ? 'lg:grid-cols-[minmax(0,420px)_minmax(0,380px)] lg:gap-24' : ''
        } lg:content-center lg:pt-0"
      >
        <section class="flex w-full max-w-[420px] min-w-0 flex-col gap-6">
          ${body}
          ${
            signin && pageHost
              ? html`<p
                  class="flex items-center gap-2 text-[12.5px] text-muted-foreground lg:hidden"
                >
                  ${shieldIcon}<span
                    >${m.record.mini}
                    <b class="font-medium text-foreground">${pageHost}</b></span
                  >
                </p>`
              : null
          }
        </section>
        ${signin ? html`<div class="hidden lg:block">${signinRecord(locale, signin)}</div>` : null}
      </main>`;

  return `<!doctype html>${html`<html lang="${locale}" dir="${directionOf(locale)}">
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
    <body class="min-h-svh bg-panel text-foreground antialiased">
      <a
        href="#main"
        class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:inline-flex focus:min-h-target focus:items-center focus:rounded-md focus:bg-background focus:px-3 focus:ring-3 focus:ring-ring/50 focus:outline-none"
        >${m.skipToContent}</a
      >
      <div class="grid min-h-svh grid-rows-[auto_1fr_auto]">
        <header
          class="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-10 sm:py-5"
        >
          <span class="flex items-center gap-2.5 text-[19px] font-semibold tracking-[-0.01em]"
            >${logo}${m.productName}</span
          >
          ${languages}
        </header>
        ${main}
        <footer
          class="flex flex-wrap justify-between gap-2 border-t px-4 py-4 text-[13px] text-muted-foreground sm:px-10"
        >
          <span>${m.footer.product}</span>
          <span class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>${m.footer.help}</span>
            ${
              privacyUrl
                ? html`<a
                    href="${privacyUrl}"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex min-h-target items-center text-foreground underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
                    >${m.footer.privacy}<span class="sr-only"> ${m.footer.newTab}</span></a
                  >`
                : null
            }
          </span>
        </footer>
      </div>
    </body>
  </html>`}`;
}

export function alertBox(id: string, title: string, action?: string): SafeHtml {
  return html`<div
    id="${id}"
    role="alert"
    class="flex items-start gap-2.5 rounded-[10px] bg-destructive/10 px-3.5 py-3 text-sm leading-normal"
  >
    ${alertIcon}
    <p><span class="font-semibold">${title}</span>${action ? html` ${action}` : null}</p>
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
  /** The sign-in policy allows passkeys (default: yes). */
  passkeys?: boolean;
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
    cancelLabel: format(m.cancelTo, { client: opts.clientName }),
    client: opts.clientName,
    languagePath: `/interaction/${opts.uid}`,
    passkey: opts.passkeys === false ? undefined : `/interaction/${opts.uid}/passkey`,
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
  /** The sign-in policy allows passkeys (default: yes). */
  passkeys?: boolean;
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
    passkey: opts.passkeys === false ? undefined : '/account/passkey',
  });
}

/** aria-describedby for the given ids (none: no attribute). Ids are our own constants. */
function describedByIds(...ids: (string | undefined)[]): SafeHtml | null {
  const list = ids.filter(Boolean).join(' ');
  return list ? raw(`aria-describedby="${list}"`) : null;
}

function credentialsPage(opts: {
  locale: Locale;
  title: string;
  subtitle: string;
  action: string;
  cancelAction?: string;
  /** Text of the cancel button (default: "Cancel sign-in"). */
  cancelLabel?: string;
  /** The app being signed in to (none: the account pages). */
  client?: string;
  languagePath: string;
  /** Where a passkey sign-in posts (its options at `${passkey}/options`); none: off. */
  passkey?: string;
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

  const others = alternatives({
    passkey: opts.passkey,
    providers: opts.providerLinks,
    text: m.passkey,
    continueWith: m.continueWith,
    or: m.orPassword,
    cancelled: m.passkeyCancelled,
    failed: `${m.passkeyFailed} ${m.passkeyFailedAction}`,
  });
  const body = html`<div>
      <h1 class="${heading}">${opts.title}</h1>
      <p class="${lede}">${opts.subtitle}</p>
    </div>
    ${opts.notice ? noticeBox(opts.notice) : null} ${error} ${others}
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
          ${describedByIds(describedBy, opts.usernames ? 'email-hint' : undefined)}
        />
        ${
          opts.usernames
            ? html`<p id="email-hint" class="text-[12.5px] text-muted-foreground">
                ${m.identifierHint}
              </p>`
            : null
        }
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
      <button type="submit" class="${primary} mt-1">${m.submit}</button>
    </form>
    ${
      opts.cancelAction
        ? html`<form method="post" action="${opts.cancelAction}">
            <button type="submit" class="${textLink} text-[13.5px]">
              ${opts.cancelLabel ?? m.cancel}
            </button>
          </form>`
        : null
    }`;
  return layout({
    locale: opts.locale,
    title: opts.title,
    body,
    languagePath: opts.languagePath,
    passkeys: !!opts.passkey,
    signin: { client: opts.client, step: 1 },
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
  passkey?: string;
  providers: { name: string; href: string }[];
  text: string;
  continueWith: string;
  or: string;
  cancelled: string;
  failed: string;
}): SafeHtml {
  // Nothing else to offer: passkeys off and no identity providers.
  if (!o.passkey && o.providers.length === 0) return html``;
  // Without providers the block shows only where passkeys work.
  const onlyPasskey = o.providers.length === 0;
  return html`<div
    class="flex flex-col gap-2.5"
    ${onlyPasskey ? raw('data-passkey-block hidden') : null}
  >
    ${o.providers.map(
      (p) =>
        html`<a href="${p.href}" class="${secondary} justify-start" data-testid="provider"
          ><span aria-hidden="true" class="grid size-6 place-items-center rounded-md bg-well"
            >${shieldIcon}</span
          >${format(o.continueWith, { provider: p.name })}</a
        >`,
    )}
    ${
      o.passkey
        ? html`<form
            id="passkey-form"
            method="post"
            action="${o.passkey}"
            data-passkey-block
            hidden
          >
            <input type="hidden" name="challenge" />
            <input type="hidden" name="response" />
            <button
              type="button"
              class="${secondary} justify-start"
              data-passkey="signin"
              data-options="${o.passkey}/options"
              data-status="passkey-status"
            >
              <span aria-hidden="true" class="grid size-6 place-items-center rounded-md bg-well"
                >${keyIcon}</span
              >${o.text}
            </button>
          </form>`
        : null
    }
    <p
      id="passkey-status"
      aria-live="polite"
      class="text-sm text-muted-foreground empty:hidden"
      data-cancelled="${o.cancelled}"
      data-failed="${o.failed}"
    ></p>
    <p class="mt-2 flex items-center gap-3 text-[13px] text-muted-foreground">
      <span aria-hidden="true" class="h-px flex-1 bg-border"></span>${o.or}<span
        aria-hidden="true"
        class="h-px flex-1 bg-border"
      ></span>
    </p>
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
    <h1 class="${heading}">${m.title}</h1>
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
      <h1 class="${heading}">${m.title}</h1>
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
    <h1 class="${heading}">${m.doneTitle}</h1>
    <p class="text-muted-foreground">${m.doneBody}</p>
  </div>`;
  return layout({ locale: opts.locale, title: m.doneTitle, body });
}

export function noticeBox(text: string): SafeHtml {
  return html`<p role="status" class="rounded-lg border px-3 py-2.5 text-sm">${text}</p>`;
}

export type CodeError = { attemptsLeft: number } | 'invalid' | 'expired';

/** One field for a TOTP or recovery code; paste allowed (WCAG 3.3.8). */
function codeField(
  locale: Locale,
  error: CodeError | undefined,
  describedBy: string | undefined,
  /** A recovery code is accepted too (not while setting up). */
  recovery = true,
) {
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
      class="${input} h-14 font-mono text-[22px] tracking-[0.2em]"
      autofocus
      ${raw(error ? 'aria-invalid="true"' : '')}
      ${describedByIds(describedBy, recovery ? 'code-hint' : undefined)}
    />
    ${recovery ? html`<p id="code-hint" class="text-[12.5px] text-muted-foreground">${m.codeHint}</p>` : null}
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
  /** The app being signed in to (none: the account pages). */
  client?: string;
  languagePath?: string;
  challenge?: string;
  error?: CodeError;
}): string {
  const m = MESSAGES[opts.locale].mfa;
  const error = codeError(opts.locale, opts.error);
  const body = html`<div>
      <h1 class="${heading}">${m.title}</h1>
      <p class="${lede}">${m.subtitle}</p>
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
            <button type="submit" class="${primary} mt-1">${m.submit}</button>
            <p class="text-[13.5px] text-muted-foreground">${m.lostDevice}</p>
          </form>`
    }
    ${
      opts.cancelAction
        ? html`<form method="post" action="${opts.cancelAction}">
            <button type="submit" class="${textLink} text-[13.5px] text-muted-foreground">
              ${m.cancel}
            </button>
          </form>`
        : null
    }`;
  return layout({
    locale: opts.locale,
    title: m.title,
    body,
    languagePath: opts.languagePath,
    signin: { client: opts.client, step: 2 },
  });
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
  /** The sign-in policy requires two-step verification: it cannot be turned off. */
  twoStepRequired?: boolean;
  /** The sign-in policy allows passkeys (default: yes). */
  passkeysAllowed?: boolean;
  /** "Download my data" is offered. */
  dataExport?: boolean;
}

/** Passkeys of the account, when the sign-in policy allows them. */
function passkeysSection(
  opts: { locale: Locale } & AccountView,
  m: (typeof MESSAGES)[Locale]['account'],
  when: Intl.DateTimeFormat,
): SafeHtml {
  return html`<section
    aria-labelledby="passkeys"
    class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
  >
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
            class="flex flex-col divide-y rounded-[10px] border text-sm"
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
                  <form method="post" action="/account/passkeys/${encodeURIComponent(p.id)}/delete">
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
  </section>`;
}

/** The account page: two-step verification and recent activity. */
export function accountPage(opts: { locale: Locale } & AccountView): string {
  const m = MESSAGES[opts.locale].account;
  const when = new Intl.DateTimeFormat(opts.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const body = html`<div class="flex flex-col gap-1">
      <h1 class="${heading}">${m.title}</h1>
      <p class="text-sm text-muted-foreground">${opts.name} · ${opts.email}</p>
    </div>
    ${opts.notice ? noticeBox(opts.notice) : null}
    ${
      opts.nameEditable
        ? html`<section
            aria-labelledby="profile"
            class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
          >
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
    <section
      aria-labelledby="two-step"
      class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
    >
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
              ${
                opts.twoStepRequired
                  ? html`<p class="text-sm text-muted-foreground">${m.twoStepRequired}</p>`
                  : html`<a href="/account/two-step/off" class="${secondary}">${m.turnOff}</a>`
              }`
          : html`<a href="/account/two-step/setup" class="${primary}">${m.setUp}</a>`
      }
    </section>
    ${opts.passkeysAllowed === false ? null : passkeysSection(opts, m, when)}
    <section aria-labelledby="activity" class="flex flex-col gap-2">
      <h2 id="activity" class="font-semibold">${m.activity}</h2>
      ${
        opts.events.length === 0
          ? html`<p class="text-sm text-muted-foreground">${m.noActivity}</p>`
          : html`<ul
              class="flex flex-col divide-y rounded-[10px] border border-rule-strong bg-background text-sm"
            >
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
    ${
      opts.dataExport
        ? html`<section
            aria-labelledby="your-data"
            class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
          >
            <h2 id="your-data" class="font-semibold">${m.yourData}</h2>
            <p class="text-sm text-muted-foreground">${m.yourDataBody}</p>
            <form method="post" action="/account/data">
              <button type="submit" class="${secondary}">${m.downloadData}</button>
            </form>
          </section>`
        : null
    }
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
  /**
   * Required by the sign-in policy, while signing in to an app: the form posts
   * to the interaction and "Cancel" ends the sign-in (default: the account pages).
   */
  interaction?: { action: string; cancelAction: string; client?: string };
}): string {
  const m = MESSAGES[opts.locale].account;
  const error = codeError(opts.locale, opts.error);
  const action = opts.interaction?.action ?? '/account/two-step/setup';
  // The key in groups of four, easier to type.
  const grouped = opts.secret.replace(/(.{4})/g, '$1 ').trim();
  const body = html`<div>
      <h1 class="${heading}">${m.setupTitle}</h1>
      ${opts.interaction ? html`<p class="${lede}">${m.setupRequired}</p>` : null}
    </div>
    <div class="grid items-center gap-5 sm:grid-cols-[168px_1fr]">
      <figure
        role="img"
        aria-label="${m.qrLabel}"
        class="w-[168px] rounded-[10px] border border-rule-strong bg-white p-2.5 [&>svg]:h-auto [&>svg]:w-full"
      >
        ${raw(opts.qrSvg)}
      </figure>
      <div class="flex flex-col gap-3 text-sm leading-5">
        <ol class="flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
          <li>${m.setupStep1}</li>
          <li>${m.setupStep3}</li>
        </ol>
        <p class="text-[12.5px] text-muted-foreground">
          ${m.setupStep2}
          <code
            data-testid="totp-secret"
            class="mt-1 block font-mono text-[15px] tracking-wide break-all text-foreground select-all"
            >${grouped}</code
          >
        </p>
      </div>
    </div>
    ${error}
    <form method="post" action="${action}" class="flex flex-col gap-4">
      ${codeField(opts.locale, opts.error, error ? 'code-error' : undefined, false)}
      <button type="submit" class="${primary}">${m.confirm}</button>
    </form>
    ${
      opts.interaction
        ? html`<form method="post" action="${opts.interaction.cancelAction}">
            <button type="submit" class="${textLink} text-[13.5px] text-muted-foreground">
              ${m.cancel}
            </button>
          </form>`
        : html`<a href="/account" class="${secondary}">${m.cancel}</a>`
    }`;
  return layout({
    locale: opts.locale,
    title: m.setupTitle,
    body,
    signin: opts.interaction
      ? { client: opts.interaction.client, step: 2, setup: true }
      : undefined,
  });
}

/** Recovery codes, shown once. */
export function recoveryCodesPage(opts: {
  locale: Locale;
  codes: string[];
  /** While signing in to an app: "Continue" posts here to finish the sign-in. */
  continueAction?: string;
  /** The app being signed in to, while signing in. */
  client?: string;
}): string {
  const m = MESSAGES[opts.locale].account;
  const body = html`<div>
      <h1 class="${heading}">${m.codesTitle}</h1>
      <p class="${lede}">${m.codesBody}</p>
    </div>
    <ul
      data-testid="recovery-codes"
      class="grid grid-cols-2 gap-x-6 gap-y-2 rounded-[10px] border border-rule-strong bg-background px-5 py-4 font-mono text-[15px] select-all"
    >
      ${opts.codes.map((c) => html`<li>${c}</li>`)}
    </ul>
    ${
      opts.continueAction
        ? html`<form method="post" action="${opts.continueAction}">
            <button type="submit" class="${primary} w-full">${m.codesContinue}</button>
          </form>`
        : html`<a href="/account" class="${primary}">${m.codesDone}</a>`
    }`;
  return layout({
    locale: opts.locale,
    title: m.codesTitle,
    body,
    signin: opts.continueAction ? { client: opts.client, step: 2, setup: true } : undefined,
  });
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
  const body = html`<div>
      <h1 class="${heading}">${opts.title}</h1>
      <p class="${lede}">${opts.body}</p>
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
