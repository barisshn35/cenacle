// SPDX-License-Identifier: Apache-2.0
// Pages of the Cenacle ID admin panel (server-rendered, no script needed).
import type { LdapConfig } from '../directory/ldap.ts';
import type { Source, SyncRun } from '../directory/store.ts';
import { html, type SafeHtml } from '../ui/html.ts';
import { format, type Locale } from '../ui/messages.ts';
import { alertBox, layout, noticeBox } from '../ui/pages.ts';
import { ADMIN_MESSAGES } from './messages.ts';

const button =
  'inline-flex min-h-target min-w-target h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-input bg-background hover:bg-muted`;
const destructive = `${button} border border-destructive/40 text-destructive hover:bg-destructive/10`;
const input =
  'block min-h-target h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';
const textarea =
  'block min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';
const label = 'text-sm font-medium';
const hint = 'text-xs text-muted-foreground';
const link =
  'inline-flex min-h-target items-center rounded-md px-1 underline-offset-4 hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

export interface AdminAccount {
  id: string;
  displayName: string;
  email: string | null;
  username: string | null;
  fromDirectory: boolean;
  disabled: boolean;
  twoStep: boolean;
  isAdmin: boolean;
}

function frame(
  locale: Locale,
  title: string,
  current: 'accounts' | 'directories',
  body: SafeHtml,
): string {
  const m = ADMIN_MESSAGES[locale];
  const tab = (key: 'accounts' | 'directories', href: string) =>
    key === current
      ? html`<a href="${href}" aria-current="page" class="${link} font-semibold">${m.nav[key]}</a>`
      : html`<a href="${href}" class="${link} text-muted-foreground">${m.nav[key]}</a>`;
  return layout({
    locale,
    wide: true,
    title,
    languagePath: '/account/admin',
    body: html`<nav
        aria-label="${m.title}"
        class="flex flex-wrap items-center gap-4 border-b pb-3 text-sm"
      >
        <span class="font-display text-xl font-medium">${m.title}</span>
        ${tab('accounts', '/account/admin')} ${tab('directories', '/account/admin/directories')}
        <a href="/account" class="${link} ml-auto text-muted-foreground">${m.nav.back}</a>
      </nav>
      ${body}`,
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
        <td class="py-2 pr-3">
          <p class="font-medium">${a.displayName}</p>
          <p class="${hint}">${[a.email, a.username].filter(Boolean).join(' · ')}</p>
        </td>
        <td class="py-2 pr-3">${a.fromDirectory ? m.directory : m.local}</td>
        <td class="py-2 pr-3">
          <p>${a.disabled ? m.disabled : m.active}</p>
          ${a.twoStep ? html`<p class="${hint}">${m.twoStep}</p>` : null}
          ${a.isAdmin ? html`<p class="${hint}">${m.admin}</p>` : null}
        </td>
        <td class="py-2">
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
          : html`<div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <caption class="sr-only">
                  ${m.title}
                </caption>
                <thead class="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" class="pb-2">${m.name}</th>
                    <th scope="col" class="pb-2">${m.signIn}</th>
                    <th scope="col" class="pb-2">${m.status}</th>
                    <th scope="col" class="pb-2">${m.actions}</th>
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
          : html`<ul class="flex flex-col divide-y rounded-lg border">
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
    html`<fieldset class="flex flex-col gap-3 rounded-lg border p-4">
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
          <section aria-labelledby="preview-title" class="rounded-lg border p-4 text-sm">
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
    ? html`<table class="w-full text-left text-sm">
        <caption class="sr-only">
          ${m.history}
        </caption>
        <thead class="text-xs text-muted-foreground">
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
      </table>`
    : html`<p class="text-sm text-muted-foreground">${m.historyNone}</p>`;

  return frame(
    opts.locale,
    opts.id ? format(m.title, { name: opts.form.name }) : m.newTitle,
    'directories',
    html`<h1 class="font-display text-2xl font-medium">
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
                class="flex flex-col gap-3 rounded-lg border p-4"
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
