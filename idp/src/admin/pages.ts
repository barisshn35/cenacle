// SPDX-License-Identifier: AGPL-3.0-only
// Pages of the Cenacle ID admin panel (server-rendered, no script needed).
import type { LdapConfig } from '../directory/ldap.ts';
import type { Source, SyncRun } from '../directory/store.ts';
import type { OidcConfig, ProviderKind, SamlConfig } from '../federation/config.ts';
import { federationUrls } from '../federation/protocols.ts';
import { html, raw, type SafeHtml } from '../ui/html.ts';
import { format, type Locale } from '../ui/messages.ts';
import { alertBox, layout, noticeBox } from '../ui/pages.ts';
import { ADMIN_MESSAGES } from './messages.ts';

const button =
  'inline-flex min-h-target min-w-target h-8 items-center justify-center gap-2 rounded-[7px] px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-input bg-background hover:bg-muted`;
const destructive = `${button} border border-destructive/40 text-destructive hover:bg-destructive/10`;
const input =
  'block min-h-target h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';
const textarea =
  'block min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';
const label = 'text-sm font-medium';
const hint = 'text-xs text-muted-foreground';

export interface AdminAccount {
  id: string;
  displayName: string;
  email: string | null;
  username: string | null;
  fromDirectory: boolean;
  fromProvider: boolean;
  disabled: boolean;
  twoStep: boolean;
  isAdmin: boolean;
}

function frame(
  locale: Locale,
  title: string,
  current: 'accounts' | 'directories' | 'providers' | 'signIn',
  body: SafeHtml,
): string {
  const m = ADMIN_MESSAGES[locale];
  const tab = (key: 'accounts' | 'directories' | 'providers' | 'signIn', href: string) =>
    html`<a
      href="${href}"
      ${key === current ? raw('aria-current="page"') : null}
      class="flex h-8 min-h-target items-center rounded-[7px] px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
        key === current ? 'bg-accent font-semibold' : 'hover:bg-muted'
      }"
      >${m.nav[key]}</a
    >`;
  return layout({
    locale,
    wide: true,
    title,
    languagePath: '/account/admin',
    body: html`<div class="grid gap-8 md:grid-cols-[200px_minmax(0,1fr)]">
      <nav aria-label="${m.title}" class="flex flex-col gap-0.5 md:pt-1">
        <p class="px-2.5 pb-2 text-xs font-semibold text-muted-foreground">${m.title}</p>
        ${tab('accounts', '/account/admin')} ${tab('directories', '/account/admin/directories')}
        ${tab('providers', '/account/admin/providers')} ${tab('signIn', '/account/admin/sign-in')}
        <a
          href="/account"
          class="mt-3 flex h-8 min-h-target items-center rounded-[7px] px-2.5 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >← ${m.nav.back}</a
        >
      </nav>
      <div class="flex min-w-0 flex-col gap-6">
        ${
          // Pages without their own heading take the title of the section.
          body.value.includes('<h1')
            ? null
            : html`<h1 class="text-2xl leading-8 font-semibold tracking-[-0.015em]">${title}</h1>`
        }
        ${body}
      </div>
    </div>`,
  });
}

function actionForm(
  action: string,
  labelText: string,
  cls: string,
  hidden: Record<string, string> = {},
) {
  return html`<form method="post" action="${action}" class="inline">
    ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
    <button type="submit" class="${cls}">${labelText}</button>
  </form>`;
}

export function accountsPage(opts: {
  locale: Locale;
  query: string;
  accounts: AdminAccount[];
  next?: string;
  selfId: string;
  notice?: string;
  error?: string;
}): string {
  const m = ADMIN_MESSAGES[opts.locale].accounts;
  const rows = opts.accounts.map(
    (a) =>
      html`<tr class="border-t align-top">
        <td class="px-3 py-2.5">
          <p class="font-medium">${a.displayName}</p>
          <p class="${hint}">${[a.email, a.username].filter(Boolean).join(' · ')}</p>
        </td>
        <td class="px-3 py-2.5">
          ${a.fromDirectory ? m.directory : a.fromProvider ? m.provider : m.local}
        </td>
        <td class="px-3 py-2.5">
          <p>${a.disabled ? m.disabled : m.active}</p>
          ${a.twoStep ? html`<p class="${hint}">${m.twoStep}</p>` : null}
          ${a.isAdmin ? html`<p class="${hint}">${m.admin}</p>` : null}
        </td>
        <td class="px-3 py-2.5">
          <div class="flex flex-wrap gap-2">
            ${
              a.id === opts.selfId
                ? html`<span class="${hint}">—</span>`
                : html`${
                    a.fromDirectory
                      ? html`<span class="${hint} self-center">${m.managedByDirectory}</span>`
                      : actionForm(
                          `/account/admin/accounts/${a.id}/${a.disabled ? 'enable' : 'disable'}`,
                          a.disabled ? m.enable : m.disable,
                          a.disabled ? secondary : destructive,
                        )
                  }
                  ${
                    a.twoStep
                      ? actionForm(
                          `/account/admin/accounts/${a.id}/reset-two-step`,
                          m.resetTwoStep,
                          secondary,
                        )
                      : null
                  }
                  ${actionForm(
                    `/account/admin/accounts/${a.id}/${a.isAdmin ? 'remove-admin' : 'make-admin'}`,
                    a.isAdmin ? m.removeAdmin : m.makeAdmin,
                    secondary,
                  )}`
            }
          </div>
        </td>
      </tr>`,
  );
  return frame(
    opts.locale,
    m.title,
    'accounts',
    html`${opts.notice ? noticeBox(opts.notice) : null}
      ${opts.error ? alertBox('admin-error', opts.error) : null}
      <form method="get" action="/account/admin" role="search" class="flex gap-2">
        <label for="q" class="sr-only">${m.search}</label>
        <input
          id="q"
          name="q"
          type="search"
          value="${opts.query}"
          placeholder="${m.search}"
          class="${input} max-w-md"
        />
        <button type="submit" class="${secondary}">${m.searchButton}</button>
      </form>
      ${
        opts.accounts.length === 0
          ? html`<p class="text-sm text-muted-foreground">${m.none}</p>`
          : html`<div
              class="overflow-x-auto rounded-[10px] border border-rule-strong bg-background"
              role="region"
              aria-label="${m.title}"
              tabindex="0"
            >
              <table class="w-full text-left text-sm">
                <caption class="sr-only">
                  ${m.title}
                </caption>
                <thead class="bg-secondary text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" class="px-3 py-2.5 font-semibold">${m.name}</th>
                    <th scope="col" class="px-3 py-2.5 font-semibold">${m.signIn}</th>
                    <th scope="col" class="px-3 py-2.5 font-semibold">${m.status}</th>
                    <th scope="col" class="px-3 py-2.5 font-semibold">${m.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>
            </div>`
      }
      ${
        opts.next
          ? html`<a
              class="${secondary} self-start"
              href="/account/admin?q=${encodeURIComponent(opts.query)}&after=${opts.next}"
              >${m.more}</a
            >`
          : null
      }`,
  );
}

function when(locale: Locale, d: Date | null, never: string): string {
  return d
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
    : never;
}

export function directoriesPage(opts: { locale: Locale; sources: Source[] }): string {
  const m = ADMIN_MESSAGES[opts.locale].directories;
  return frame(
    opts.locale,
    m.title,
    'directories',
    html`<p class="max-w-2xl text-sm text-muted-foreground">${m.intro}</p>
      ${
        opts.sources.length === 0
          ? html`<p class="text-sm">${m.none}</p>`
          : html`<ul
              class="flex flex-col divide-y rounded-[10px] border border-rule-strong bg-background"
            >
              ${opts.sources.map(
                (s) =>
                  html`<li class="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                    <div class="min-w-0 flex-1">
                      <p class="font-medium">${s.name}</p>
                      <p class="${hint}">
                        ${s.config.urls.join(', ')} · ${s.enabled ? m.enabled : m.off} ·
                        ${m.lastSync}: ${when(opts.locale, s.lastSyncAt, m.never)}
                      </p>
                    </div>
                    <a class="${secondary}" href="/account/admin/directories/${s.id}">${m.open}</a>
                  </li>`,
              )}
            </ul>`
      }
      <form
        method="get"
        action="/account/admin/directories/new"
        class="flex flex-wrap items-end gap-2"
      >
        <div class="flex flex-col gap-1.5">
          <label for="preset" class="${label}">${m.preset}</label>
          <select id="preset" name="preset" class="${input}">
            <option value="active_directory">${m.presetAd}</option>
            <option value="openldap">${m.presetOpenldap}</option>
          </select>
        </div>
        <button type="submit" class="${primary}">${m.add}</button>
      </form>`,
  );
}

export interface DirectoryForm {
  name: string;
  config: Partial<LdapConfig> & { urls?: string[] };
  enabled: boolean;
  syncIntervalMinutes: number;
  hasSecret: boolean;
}

export type DirectoryOutcome =
  | { kind: 'saved' }
  | { kind: 'invalid'; fields: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'test'; people: number; groups: number }
  | { kind: 'synced'; seen: number; created: number; updated: number; deactivated: number }
  | {
      kind: 'preview';
      person: {
        displayName: string;
        email: string | null;
        title: string | null;
        username: string;
      } | null;
      role: 'admin' | 'guest' | null;
      groups: string[];
    };

export function directoryPage(opts: {
  locale: Locale;
  id?: string;
  form: DirectoryForm;
  runs: SyncRun[];
  outcome?: DirectoryOutcome;
}): string {
  const m = ADMIN_MESSAGES[opts.locale].directory;
  const c = opts.form.config;
  const invalid = new Set(opts.outcome?.kind === 'invalid' ? opts.outcome.fields : []);
  const action = opts.id
    ? `/account/admin/directories/${opts.id}`
    : '/account/admin/directories/new';
  const field = (
    name: keyof LdapConfig | 'name' | 'bindPassword' | 'syncInterval',
    text: string,
    value: string | number | undefined,
    extra: { hint?: string; type?: string; placeholder?: string } = {},
  ) =>
    html`<div class="flex flex-col gap-1.5">
      <label for="${name}" class="${label}">${text}</label>
      <input
        id="${name}"
        name="${name}"
        type="${extra.type ?? 'text'}"
        value="${value ?? ''}"
        placeholder="${extra.placeholder ?? ''}"
        autocomplete="off"
        spellcheck="false"
        class="${input}"
        aria-invalid="${invalid.has(name) ? 'true' : 'false'}"
        ${extra.hint ? html`aria-describedby="${name}-hint"` : null}
      />
      ${extra.hint ? html`<p id="${name}-hint" class="${hint}">${extra.hint}</p>` : null}
    </div>`;
  const area = (name: keyof LdapConfig, text: string, value: string, hintText?: string) =>
    html`<div class="flex flex-col gap-1.5">
      <label for="${name}" class="${label}">${text}</label>
      <textarea
        id="${name}"
        name="${name}"
        spellcheck="false"
        class="${textarea}"
        aria-invalid="${invalid.has(name) ? 'true' : 'false'}"
        ${hintText ? html`aria-describedby="${name}-hint"` : null}
      >
${value}</textarea>
      ${hintText ? html`<p id="${name}-hint" class="${hint}">${hintText}</p>` : null}
    </div>`;
  const section = (title: string, body: SafeHtml) =>
    html`<fieldset
      class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
    >
      <legend class="px-1 text-sm font-semibold">${title}</legend>
      <div class="grid gap-3 sm:grid-cols-2">${body}</div>
    </fieldset>`;

  let outcome: SafeHtml | null = null;
  const o = opts.outcome;
  if (o?.kind === 'saved') outcome = noticeBox(m.saved);
  else if (o?.kind === 'invalid')
    outcome = alertBox('directory-error', format(m.invalid, { fields: o.fields.join(', ') }));
  else if (o?.kind === 'error')
    outcome = alertBox('directory-error', format(m.error, { message: o.message }));
  else if (o?.kind === 'test')
    outcome = noticeBox(format(m.testOk, { people: o.people, groups: o.groups }));
  else if (o?.kind === 'synced')
    outcome = noticeBox(
      format(m.synced, {
        seen: o.seen,
        created: o.created,
        updated: o.updated,
        deactivated: o.deactivated,
      }),
    );
  else if (o?.kind === 'preview')
    outcome = o.person
      ? html`<div role="status">
          <section
            aria-labelledby="preview-title"
            class="rounded-[10px] border border-rule-strong bg-background p-4 text-sm"
          >
            <h2 id="preview-title" class="mb-2 font-semibold">${m.previewResult}</h2>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt class="text-muted-foreground">${m.nameAttribute}</dt>
              <dd>${o.person.displayName}</dd>
              <dt class="text-muted-foreground">${m.previewName}</dt>
              <dd>${o.person.username}</dd>
              <dt class="text-muted-foreground">${m.emailAttribute}</dt>
              <dd>${o.person.email ?? '—'}</dd>
              <dt class="text-muted-foreground">${m.titleAttribute}</dt>
              <dd>${o.person.title ?? '—'}</dd>
              <dt class="text-muted-foreground">${m.previewRole}</dt>
              <dd>
                ${o.role === 'admin' ? m.roleAdmin : o.role === 'guest' ? m.roleGuest : m.roleNone}
              </dd>
              <dt class="text-muted-foreground">${m.previewGroups}</dt>
              <dd>${o.groups.join(', ') || '—'}</dd>
            </dl>
          </section>
        </div>`
      : noticeBox(m.previewNone);

  const runs = opts.runs.length
    ? html`<div
        class="overflow-x-auto rounded-[10px] border border-rule-strong bg-background"
        role="region"
        aria-label="${m.history}"
        tabindex="0"
      >
        <table class="w-full text-left text-sm">
          <caption class="sr-only">
            ${m.history}
          </caption>
          <thead class="bg-secondary text-xs text-muted-foreground">
            <tr>
              <th scope="col" class="pb-1">${m.started}</th>
              <th scope="col" class="pb-1">${m.result}</th>
            </tr>
          </thead>
          <tbody>
            ${opts.runs.map(
              (r) =>
                html`<tr class="border-t align-top">
                  <td class="py-1.5 pr-3">${when(opts.locale, r.startedAt, '')}</td>
                  <td class="py-1.5">
                    <p>${m[r.status]}</p>
                    <p class="${hint}">
                      ${
                        r.error ||
                        format(m.counts, {
                          seen: r.usersSeen,
                          created: r.usersCreated,
                          updated: r.usersUpdated,
                          deactivated: r.usersDeactivated,
                          groups: r.groups,
                        })
                      }
                    </p>
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<p class="text-sm text-muted-foreground">${m.historyNone}</p>`;

  return frame(
    opts.locale,
    opts.id ? format(m.title, { name: opts.form.name }) : m.newTitle,
    'directories',
    html`<h1 class="text-2xl leading-8 font-semibold tracking-[-0.015em]">
        ${opts.id ? format(m.title, { name: opts.form.name }) : m.newTitle}
      </h1>
      ${outcome}
      <form method="post" action="${action}" class="flex flex-col gap-4">
        ${section(
          m.connection,
          html`${field('name', m.name, opts.form.name)}
            ${field('syncInterval', m.syncInterval, opts.form.syncIntervalMinutes, { type: 'number' })}
            <div class="sm:col-span-2">
              ${area('urls', m.urls, (c.urls ?? []).join('\n'), m.urlsHint)}
            </div>
            ${field('bindDn', m.bindDn, c.bindDn)}
            ${field('bindPassword', m.bindPassword, '', {
              type: 'password',
              hint: opts.form.hasSecret ? m.bindPasswordKeep : undefined,
            })}
            <label class="flex min-h-target items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                name="startTls"
                value="1"
                ${c.startTls ? html`checked` : null}
                class="size-4"
              />
              ${m.startTls}
            </label>
            <div class="sm:col-span-2">${area('caCert', m.caCert, c.caCert ?? '')}</div>
            <label class="flex min-h-target items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                name="enabled"
                value="1"
                ${opts.form.enabled ? html`checked` : null}
                class="size-4"
              />
              ${m.enabled}
            </label>`,
        )}
        ${section(
          m.people,
          html`${field('baseDn', m.baseDn, c.baseDn)}
            ${field('loginAttribute', m.loginAttribute, c.loginAttribute, { hint: m.loginAttributeHint })}
            <div class="sm:col-span-2">
              ${area('userFilter', m.userFilter, c.userFilter ?? '', m.userFilterHint)}
            </div>
            ${field('idAttribute', m.idAttribute, c.idAttribute)}`,
        )}
        ${section(
          m.attributes,
          html`${field('nameAttribute', m.nameAttribute, c.nameAttribute)}
          ${field('firstNameAttribute', m.firstNameAttribute, c.firstNameAttribute)}
          ${field('lastNameAttribute', m.lastNameAttribute, c.lastNameAttribute)}
          ${field('emailAttribute', m.emailAttribute, c.emailAttribute)}
          ${field('titleAttribute', m.titleAttribute, c.titleAttribute)}
          ${field('photoAttribute', m.photoAttribute, c.photoAttribute)}`,
        )}
        ${section(
          m.groups,
          html`${field('groupBaseDn', m.groupBaseDn, c.groupBaseDn)}
            ${field('groupNameAttribute', m.groupNameAttribute, c.groupNameAttribute)}
            <div class="sm:col-span-2">
              ${area('groupFilter', m.groupFilter, c.groupFilter ?? '')}
            </div>
            ${field('groupIdAttribute', m.groupIdAttribute, c.groupIdAttribute)}
            ${field('memberAttribute', m.memberAttribute, c.memberAttribute)}
            <div class="flex flex-col gap-1.5 sm:col-span-2">
              <label for="groupMembership" class="${label}">${m.groupMembership}</label>
              <select id="groupMembership" name="groupMembership" class="${input}">
                <option value="member" ${c.groupMembership !== 'memberUid' ? html`selected` : null}>
                  ${m.groupMembershipMember}
                </option>
                <option
                  value="memberUid"
                  ${c.groupMembership === 'memberUid' ? html`selected` : null}
                >
                  ${m.groupMembershipUid}
                </option>
              </select>
            </div>`,
        )}
        ${section(
          m.roles,
          html`<div class="sm:col-span-2">
              ${area('adminFilter', m.adminFilter, c.adminFilter ?? '', m.rolesHint)}
            </div>
            <div class="sm:col-span-2">
              ${area('guestFilter', m.guestFilter, c.guestFilter ?? '')}
            </div>`,
        )}
        <div><button type="submit" class="${primary}">${m.save}</button></div>
      </form>
      ${
        opts.id
          ? html`<section
                aria-labelledby="tools-title"
                class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
              >
                <h2 id="tools-title" class="text-sm font-semibold">${m.sync}</h2>
                <div class="flex flex-wrap gap-2">
                  ${actionForm(`/account/admin/directories/${opts.id}/test`, m.test, secondary)}
                  ${actionForm(`/account/admin/directories/${opts.id}/sync`, m.syncNow, secondary)}
                </div>
                <form
                  method="post"
                  action="/account/admin/directories/${opts.id}/preview"
                  class="flex flex-wrap items-end gap-2"
                >
                  <div class="flex flex-col gap-1.5">
                    <label for="login" class="${label}">${m.previewName}</label>
                    <input
                      id="login"
                      name="login"
                      class="${input}"
                      autocomplete="off"
                      spellcheck="false"
                    />
                  </div>
                  <button type="submit" class="${secondary}">${m.previewButton}</button>
                </form>
              </section>
              <section aria-labelledby="history-title" class="flex flex-col gap-2">
                <h2 id="history-title" class="text-sm font-semibold">${m.history}</h2>
                ${runs}
              </section>`
          : null
      }`,
  );
}

// --- identity providers -------------------------------------------------------

export function providersPage(opts: {
  locale: Locale;
  providers: { id: string; kind: ProviderKind; name: string; enabled: boolean; people: number }[];
}): string {
  const m = ADMIN_MESSAGES[opts.locale].providers;
  return frame(
    opts.locale,
    m.title,
    'providers',
    html`<p class="max-w-2xl text-sm text-muted-foreground">${m.intro}</p>
      ${
        opts.providers.length === 0
          ? html`<p class="text-sm">${m.none}</p>`
          : html`<ul
              class="flex flex-col divide-y rounded-[10px] border border-rule-strong bg-background"
              data-testid="providers"
            >
              ${opts.providers.map(
                (p) =>
                  html`<li class="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                    <div class="min-w-0 flex-1">
                      <p class="font-medium">${p.name}</p>
                      <p class="${hint}">
                        ${p.kind === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'} ·
                        ${p.enabled ? m.enabled : m.off} · ${m.people}: ${p.people}
                      </p>
                    </div>
                    <a class="${secondary}" href="/account/admin/providers/${p.id}">${m.open}</a>
                  </li>`,
              )}
            </ul>`
      }
      <div class="flex flex-wrap gap-2">
        <a class="${primary}" href="/account/admin/providers/new?kind=oidc">${m.addOidc}</a>
        <a class="${secondary}" href="/account/admin/providers/new?kind=saml">${m.addSaml}</a>
      </div>`,
  );
}

export interface ProviderForm {
  kind: ProviderKind;
  name: string;
  enabled: boolean;
  hasSecret: boolean;
  config: Partial<OidcConfig> & Partial<SamlConfig>;
}

export function providerPage(opts: {
  locale: Locale;
  issuer: string;
  id?: string;
  form: ProviderForm;
  saved?: boolean;
  invalid?: string[];
}): string {
  const m = ADMIN_MESSAGES[opts.locale].provider;
  const f = opts.form;
  const c = f.config;
  const invalid = new Set(opts.invalid ?? []);
  const field = (
    name: string,
    text: string,
    value: string | undefined,
    extra: { hint?: string; type?: string } = {},
  ) =>
    html`<div class="flex flex-col gap-1.5">
      <label for="${name}" class="${label}">${text}</label>
      <input
        id="${name}"
        name="${name}"
        type="${extra.type ?? 'text'}"
        value="${value ?? ''}"
        autocomplete="off"
        spellcheck="false"
        class="${input}"
        aria-invalid="${invalid.has(name) ? 'true' : 'false'}"
        ${extra.hint ? html`aria-describedby="${name}-hint"` : null}
      />
      ${extra.hint ? html`<p id="${name}-hint" class="${hint}">${extra.hint}</p>` : null}
    </div>`;
  const area = (name: string, text: string, value: string) =>
    html`<div class="flex flex-col gap-1.5 sm:col-span-2">
      <label for="${name}" class="${label}">${text}</label>
      <textarea
        id="${name}"
        name="${name}"
        spellcheck="false"
        class="${textarea}"
        aria-invalid="${invalid.has(name) ? 'true' : 'false'}"
      >
${value}</textarea>
    </div>`;
  const check = (name: string, text: string, on: boolean | undefined, hintText?: string) =>
    html`<div class="flex flex-col gap-1 sm:col-span-2">
      <label class="flex min-h-target items-center gap-2 text-sm" data-target>
        <input
          type="checkbox"
          name="${name}"
          value="1"
          class="size-4 accent-primary"
          ${on ? html`checked` : null}
          ${hintText ? html`aria-describedby="${name}-hint"` : null}
        />
        ${text}
      </label>
      ${hintText ? html`<p id="${name}-hint" class="${hint}">${hintText}</p>` : null}
    </div>`;
  const section = (title: string, body: SafeHtml) =>
    html`<fieldset
      class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
    >
      <legend class="px-1 text-sm font-semibold">${title}</legend>
      <div class="grid gap-3 sm:grid-cols-2">${body}</div>
    </fieldset>`;
  const copyable = (text: string, value: string) =>
    html`<div class="flex flex-col gap-1 sm:col-span-2">
      <dt class="${label}">${text}</dt>
      <dd class="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all select-all">
        ${value}
      </dd>
    </div>`;

  const urls = opts.id ? federationUrls(opts.issuer, opts.id) : null;
  const register = urls
    ? html`<dl class="grid gap-3 sm:grid-cols-2" data-testid="register">
        ${
          f.kind === 'oidc'
            ? copyable(m.redirectUri, urls.oidcRedirect)
            : html`${copyable(m.entityId, urls.samlEntityId)} ${copyable(m.acsUrl, urls.samlAcs)}
              ${copyable(m.metadata, urls.samlMetadata)}`
        }
      </dl>`
    : html`<p class="${hint}">${m.registerAfterSave}</p>`;

  const title = opts.id
    ? format(m.title, { name: f.name })
    : f.kind === 'oidc'
      ? m.newOidc
      : m.newSaml;
  const lines = (v: string[] | undefined) => (v ?? []).join('\n');

  return frame(
    opts.locale,
    title,
    'providers',
    html`<h1 class="text-2xl leading-8 font-semibold tracking-[-0.015em]">${title}</h1>
      ${opts.saved ? noticeBox(m.saved) : null}
      ${
        opts.invalid?.length
          ? alertBox('provider-error', format(m.invalid, { fields: opts.invalid.join(', ') }))
          : null
      }
      <section
        aria-labelledby="register-title"
        class="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
      >
        <h2 id="register-title" class="text-sm font-semibold">${m.register}</h2>
        ${register}
      </section>
      <form
        method="post"
        action="${opts.id ? `/account/admin/providers/${opts.id}` : `/account/admin/providers/new?kind=${f.kind}`}"
        class="flex flex-col gap-4"
      >
        ${section(
          m.connection,
          html`${field('name', m.name, f.name)}
          ${
            f.kind === 'oidc'
              ? html`${field('issuer', m.issuer, c.issuer, { hint: m.issuerHint, type: 'url' })}
                ${field('clientId', m.clientId, c.clientId)}
                ${field('clientSecret', m.clientSecret, '', {
                  type: 'password',
                  hint: f.hasSecret ? m.clientSecretKeep : undefined,
                })}
                ${field('scopes', m.scopes, c.scopes)}
                ${field('groupsClaim', m.groupsClaim, c.groupsClaim)}`
              : html`${field('entryPoint', m.entryPoint, c.entryPoint, { type: 'url' })}
                ${field('idpEntityId', m.idpEntityId, c.idpEntityId)}
                ${area('idpCert', m.idpCert, c.idpCert ?? '')}`
          }`,
        )}
        ${
          f.kind === 'saml'
            ? section(
                m.attributes,
                html`${field('emailAttribute', m.emailAttribute, c.emailAttribute)}
                ${field('nameAttribute', m.nameAttribute, c.nameAttribute)}
                ${field('groupsAttribute', m.groupsAttribute, c.groupsAttribute)}
                ${check('trustEmail', m.trustEmail, c.trustEmail)}`,
              )
            : null
        }
        ${section(
          m.accounts,
          html`${check('linkByEmail', m.linkByEmail, c.linkByEmail, m.linkByEmailHint)}
          ${area('adminGroups', m.adminGroups, lines(c.adminGroups))}
          ${area('guestGroups', m.guestGroups, lines(c.guestGroups))}
          ${check('enabled', m.enabled, f.enabled)}`,
        )}
        <div><button type="submit" class="${primary}">${m.save}</button></div>
      </form>`,
  );
}

/** The sign-in policy: two-step verification required, passkeys allowed. */
export function signInPolicyPage(opts: {
  locale: Locale;
  requireTwoStep: boolean;
  passkeys: boolean;
  saved?: boolean;
}): string {
  const m = ADMIN_MESSAGES[opts.locale].signIn;
  const check = (name: string, on: boolean, labelText: string, hint: string) =>
    html`<div class="flex gap-3">
      <input
        id="${name}"
        name="${name}"
        type="checkbox"
        value="on"
        class="mt-0.5 size-5 shrink-0 accent-[var(--accent-brand)]"
        aria-describedby="${name}-hint"
        ${raw(on ? 'checked' : '')}
      />
      <div class="flex flex-col gap-1">
        <label for="${name}" class="text-sm font-medium">${labelText}</label>
        <p id="${name}-hint" class="text-sm text-muted-foreground">${hint}</p>
      </div>
    </div>`;
  return frame(
    opts.locale,
    m.title,
    'signIn',
    html`<div class="flex max-w-2xl flex-col gap-5">
      <div class="flex flex-col gap-1">
        <h1 class="text-2xl leading-8 font-semibold tracking-[-0.015em]">${m.title}</h1>
        <p class="text-sm text-muted-foreground">${m.lead}</p>
      </div>
      ${opts.saved ? noticeBox(m.saved) : null}
      <form method="post" action="/account/admin/sign-in" class="flex flex-col gap-5">
        ${check('require_two_step', opts.requireTwoStep, m.twoStep, m.twoStepHint)}
        ${check('passkeys', opts.passkeys, m.passkeys, m.passkeysHint)}
        <p class="text-sm text-muted-foreground">${m.providersHint}</p>
        <button type="submit" class="${primary} self-start">${m.save}</button>
      </form>
    </div>`,
  );
}
