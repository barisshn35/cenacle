// SPDX-License-Identifier: AGPL-3.0-only
// The Cenacle ID admin panel (/account/admin): accounts and directories. Only
// administrators (users.is_admin) reach it, signed in on the account pages.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditAction, AuditLog } from '../accounts/audit.ts';
import type { MfaStore } from '../accounts/mfa.ts';
import type { User, UserStore } from '../accounts/users.ts';
import { ACCOUNT_COOKIE, accountUser } from '../account/session.ts';
import {
  Directory,
  DirectoryError,
  ldapConfigSchema,
  PRESETS,
  sameBindTarget,
  type LdapConfig,
} from '../directory/ldap.ts';
import { endSessions, type SourceStore } from '../directory/store.ts';
import { syncSource } from '../directory/sync.ts';
import type pg from 'pg';
import { isSameOriginPost, LOCALE_COOKIE, pageSecurityHeaders } from '../oidc/security.ts';
import { pickLocale, type Locale } from '../ui/messages.ts';
import { ADMIN_MESSAGES } from './messages.ts';
import {
  accountsPage,
  directoriesPage,
  directoryPage,
  providerPage,
  providersPage,
  signInPolicyPage,
  type DirectoryForm,
  type DirectoryOutcome,
  type ProviderForm,
} from './pages.ts';
import {
  oidcConfigSchema,
  samlConfigSchema,
  sameSecretTarget,
  type ProviderKind,
} from '../federation/config.ts';
import { endProviderSessions } from '../federation/people.ts';
import { DEFAULT_POLICY, type PolicyStore } from '../accounts/policy.ts';
import type { ProviderStore } from '../federation/store.ts';

export interface AdminOptions {
  pool: pg.Pool;
  users: UserStore;
  mfa: MfaStore;
  audit: AuditLog;
  sources: SourceStore;
  /** Identity providers (OIDC, SAML); without them their pages are not offered. */
  providers?: ProviderStore;
  issuer: string;
  cookieKeys: string[];
  formActionOrigins: string[];
  /** The sign-in policy, set on its own admin page. */
  policy?: PolicyStore;
}

const PAGE = 50;
type Body = Record<string, string | undefined>;

const TEXT_FIELDS: (keyof LdapConfig)[] = [
  'bindDn',
  'baseDn',
  'userFilter',
  'loginAttribute',
  'idAttribute',
  'nameAttribute',
  'firstNameAttribute',
  'lastNameAttribute',
  'emailAttribute',
  'titleAttribute',
  'photoAttribute',
  'groupBaseDn',
  'groupFilter',
  'groupNameAttribute',
  'groupIdAttribute',
  'memberAttribute',
  'adminFilter',
  'guestFilter',
  'caCert',
];

/** The settings form as typed (for showing it again). */
function formOf(body: Body, hasSecret: boolean): DirectoryForm {
  const config: DirectoryForm['config'] = {
    urls: (body.urls ?? '')
      .split(/\s+/)
      .map((u) => u.trim())
      .filter(Boolean),
    startTls: body.startTls === '1',
    linkByEmail: body.linkByEmail === '1',
    groupMembership: body.groupMembership === 'memberUid' ? 'memberUid' : 'member',
  };
  for (const f of TEXT_FIELDS) (config as Record<string, unknown>)[f] = (body[f] ?? '').trim();
  return {
    name: (body.name ?? '').trim(),
    config,
    enabled: body.enabled === '1',
    syncIntervalMinutes: Number(body.syncInterval ?? 60) || 60,
    hasSecret,
  };
}

/** The identity provider form as typed. */
function providerFormOf(kind: ProviderKind, body: Body, hasSecret: boolean): ProviderForm {
  const text = (k: string) => (body[k] ?? '').trim();
  const lines = (k: string) =>
    (body[k] ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  const common = {
    linkByEmail: body.linkByEmail === '1',
    adminGroups: lines('adminGroups'),
    guestGroups: lines('guestGroups'),
  };
  return {
    kind,
    name: text('name'),
    enabled: body.enabled === '1',
    hasSecret,
    config:
      kind === 'oidc'
        ? {
            issuer: text('issuer'),
            clientId: text('clientId'),
            scopes: text('scopes') || 'openid email profile',
            groupsClaim: text('groupsClaim'),
            scimTrustEmail: body.scimTrustEmail === '1',
            ...common,
          }
        : {
            entryPoint: text('entryPoint'),
            idpEntityId: text('idpEntityId'),
            idpCert: (body.idpCert ?? '').trim(),
            emailAttribute: text('emailAttribute'),
            nameAttribute: text('nameAttribute'),
            groupsAttribute: text('groupsAttribute'),
            trustEmail: body.trustEmail === '1',
            ...common,
          },
  };
}

export async function registerAdmin(app: FastifyInstance, opts: AdminOptions) {
  const { users, mfa, audit, sources, issuer, cookieKeys, formActionOrigins } = opts;

  const locale = (request: FastifyRequest): Locale =>
    pickLocale(request.cookieValue(LOCALE_COOKIE), request.headers['accept-language']);

  function page(reply: FastifyReply, status: number, body: string) {
    return reply
      .code(status)
      .headers({ ...pageSecurityHeaders(formActionOrigins), 'cache-control': 'no-store' })
      .type('text/html; charset=utf-8')
      .send(body);
  }

  /** The signed-in administrator, or a redirect to the account sign-in. */
  async function admin(request: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const user = await accountUser(users, cookieKeys, request.cookieValue(ACCOUNT_COOKIE));
    if (!user) {
      await reply.redirect('/account', 303);
      return null;
    }
    if (!user.isAdmin) {
      await reply.code(403).type('text/plain').send('Administrators only.');
      return null;
    }
    // Required by the policy and not set up yet: like /account, setting it up
    // comes first (the account cookie is issued before the setup).
    if (
      opts.policy &&
      !user.fromProvider &&
      (await opts.policy.get()).requireTwoStep &&
      !(await mfa.enabled(user.id))
    ) {
      await reply.redirect('/account/two-step/setup', 303);
      return null;
    }
    return user;
  }

  async function guardPost(request: FastifyRequest, reply: FastifyReply) {
    if (!isSameOriginPost(request, issuer)) {
      await reply.code(403).send();
      return null;
    }
    return admin(request, reply);
  }

  app.get<{ Querystring: { q?: string; after?: string; done?: string; error?: string } }>(
    '/account/admin',
    async (request, reply) => {
      const me = await admin(request, reply);
      if (!me) return;
      const loc = locale(request);
      const m = ADMIN_MESSAGES[loc].accounts;
      const query = (request.query.q ?? '').slice(0, 200);
      const found = await users.search(query, request.query.after, PAGE + 1);
      return page(
        reply,
        200,
        accountsPage({
          locale: loc,
          query,
          accounts: found.slice(0, PAGE),
          next: found.length > PAGE ? found[PAGE - 1]!.id : undefined,
          selfId: me.id,
          notice: request.query.done ? m.done : undefined,
          error: request.query.error === 'self' ? m.selfNotAllowed : undefined,
        }),
      );
    },
  );

  app.post<{ Params: { id: string; action: string } }>(
    '/account/admin/accounts/:id/:action',
    async (request, reply) => {
      const me = await guardPost(request, reply);
      if (!me) return;
      const { id, action } = request.params;
      if (id === me.id) return reply.redirect('/account/admin?error=self', 303);
      const target = await users.findById(id);
      if (!target) return reply.code(404).send();
      switch (action) {
        case 'disable':
          if (await users.setDisabledById(id, true)) await endSessions(opts.pool, [id]);
          break;
        case 'enable':
          await users.setDisabledById(id, false);
          break;
        case 'reset-two-step':
          // Sessions that passed the old second step end with it (a stolen
          // device or secret is the usual reason for a reset).
          await mfa.disable(id);
          await endSessions(opts.pool, [id]);
          break;
        case 'make-admin':
        case 'remove-admin':
          await users.setAdminById(id, action === 'make-admin');
          break;
        default:
          return reply.code(404).send();
      }
      await audit.record(
        `admin.account.${action.replaceAll('-', '_')}` as AuditAction,
        me.id,
        request.ip,
        {
          account: id,
        },
      );
      return reply.redirect('/account/admin?done=1', 303);
    },
  );

  // --- sign-in policy --------------------------------------------------------

  app.get<{ Querystring: { saved?: string } }>('/account/admin/sign-in', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const policy = opts.policy ? await opts.policy.get() : DEFAULT_POLICY;
    return page(
      reply,
      200,
      signInPolicyPage({
        locale: locale(request),
        ...policy,
        saved: request.query.saved !== undefined,
      }),
    );
  });

  app.post<{ Body: Body }>('/account/admin/sign-in', async (request, reply) => {
    const user = await guardPost(request, reply);
    if (!user) return;
    if (!opts.policy) return reply.code(404).send();
    const policy = {
      requireTwoStep: request.body?.require_two_step === 'on',
      passkeys: request.body?.passkeys === 'on',
    };
    const before = await opts.policy.get();
    await opts.policy.set(policy);
    if (policy.requireTwoStep && !before.requireTwoStep) {
      // Sessions signed in without a second step end once it is required, so
      // the next sign-in sets it up (accounts of identity providers are exempt).
      const { rows } = await opts.pool.query<{ id: string }>(
        `SELECT u.id FROM users u LEFT JOIN identity_sources s ON s.id = u.source_id
         WHERE u.totp_enabled_at IS NULL AND (s.kind IS NULL OR s.kind = 'ldap')`,
      );
      if (rows.length > 0)
        await endSessions(
          opts.pool,
          rows.map((r) => r.id),
          // The administrator stays on the page (and is sent to set it up).
          user.id,
        );
    }
    await audit.record('admin.sign_in_policy.changed', user.id, request.ip, {
      require_two_step: policy.requireTwoStep,
      passkeys: policy.passkeys,
    });
    return reply.redirect('/account/admin/sign-in?saved=1', 303);
  });

  app.get('/account/admin/directories', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    return page(
      reply,
      200,
      directoriesPage({ locale: locale(request), sources: await sources.list() }),
    );
  });

  app.get<{ Querystring: { preset?: string } }>(
    '/account/admin/directories/new',
    async (request, reply) => {
      if (!(await admin(request, reply))) return;
      const preset =
        request.query.preset === 'openldap' ? PRESETS.openldap : PRESETS.active_directory;
      const defaults = ldapConfigSchema.partial().parse({});
      return page(
        reply,
        200,
        directoryPage({
          locale: locale(request),
          form: {
            name: request.query.preset === 'openldap' ? 'LDAP' : 'Active Directory',
            config: { ...defaults, ...preset, urls: [] },
            enabled: true,
            syncIntervalMinutes: 60,
            hasSecret: false,
          },
          runs: [],
        }),
      );
    },
  );

  /** Validates the form; on success the settings, else the fields to fix. */
  function validate(form: DirectoryForm): { config: LdapConfig } | { fields: string[] } {
    const parsed = ldapConfigSchema.safeParse(form.config);
    const fields = new Set<string>();
    if (!form.name || form.name.length > 100) fields.add('name');
    if (form.syncIntervalMinutes < 5 || form.syncIntervalMinutes > 10080)
      fields.add('syncInterval');
    if (!parsed.success) for (const issue of parsed.error.issues) fields.add(String(issue.path[0]));
    return fields.size || !parsed.success ? { fields: [...fields] } : { config: parsed.data };
  }

  app.post<{ Body: Body }>('/account/admin/directories/new', async (request, reply) => {
    const me = await guardPost(request, reply);
    if (!me) return;
    const loc = locale(request);
    const form = formOf(request.body ?? {}, false);
    const v = validate(form);
    if ('fields' in v) {
      return page(
        reply,
        400,
        directoryPage({
          locale: loc,
          form,
          runs: [],
          outcome: { kind: 'invalid', fields: v.fields },
        }),
      );
    }
    const source = await sources.create({
      name: form.name,
      config: v.config,
      secret: request.body?.bindPassword ?? '',
      syncIntervalMinutes: form.syncIntervalMinutes,
    });
    if (!form.enabled) {
      await sources.update(source.id, { ...form, config: v.config, enabled: false });
    }
    await audit.record('admin.directory.created', me.id, request.ip, {
      source: source.id,
      name: form.name,
    });
    return reply.redirect(`/account/admin/directories/${source.id}?saved=1`, 303);
  });

  async function show(
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    outcome?: DirectoryOutcome,
    form?: DirectoryForm,
    status = 200,
  ) {
    const source = await sources.get(id);
    if (!source) return reply.code(404).send();
    return page(
      reply,
      status,
      directoryPage({
        locale: locale(request),
        id,
        form: form ?? {
          name: source.name,
          config: source.config,
          enabled: source.enabled,
          syncIntervalMinutes: source.syncIntervalMinutes,
          hasSecret: source.hasSecret,
        },
        runs: await sources.runs(id),
        outcome,
      }),
    );
  }

  app.get<{ Params: { id: string }; Querystring: { saved?: string } }>(
    '/account/admin/directories/:id',
    async (request, reply) => {
      if (!(await admin(request, reply))) return;
      return show(
        request,
        reply,
        request.params.id,
        request.query.saved ? { kind: 'saved' } : undefined,
      );
    },
  );

  app.post<{ Params: { id: string }; Body: Body }>(
    '/account/admin/directories/:id',
    async (request, reply) => {
      const me = await guardPost(request, reply);
      if (!me) return;
      const source = await sources.get(request.params.id);
      if (!source) return reply.code(404).send();
      const form = formOf(request.body ?? {}, source.hasSecret);
      const v = validate(form);
      if ('fields' in v)
        return show(request, reply, source.id, { kind: 'invalid', fields: v.fields }, form, 400);
      const password = request.body?.bindPassword ?? '';
      // The saved password goes only where it was entered for: another
      // server, service account or TLS setting needs it again.
      if (
        !password &&
        source.hasSecret &&
        v.config.bindDn &&
        !sameBindTarget(source.config, v.config)
      ) {
        return show(
          request,
          reply,
          source.id,
          { kind: 'invalid', fields: ['bindPassword'] },
          { ...form, hasSecret: false },
          400,
        );
      }
      await sources.update(source.id, {
        name: form.name,
        config: v.config,
        enabled: form.enabled,
        syncIntervalMinutes: form.syncIntervalMinutes,
        ...(password ? { secret: password } : {}),
      });
      await audit.record('admin.directory.updated', me.id, request.ip, { source: source.id });
      return reply.redirect(`/account/admin/directories/${source.id}?saved=1`, 303);
    },
  );

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  app.post<{ Params: { id: string } }>(
    '/account/admin/directories/:id/test',
    async (request, reply) => {
      if (!(await guardPost(request, reply))) return;
      const source = await sources.get(request.params.id);
      if (!source) return reply.code(404).send();
      let dir: Directory | undefined;
      try {
        dir = await Directory.connect(source.config, await sources.secret(source.id));
        const [people, groups] = await Promise.all([dir.listPeople(), dir.listGroups()]);
        return show(request, reply, source.id, {
          kind: 'test',
          people: people.length,
          groups: groups.length,
        });
      } catch (err) {
        return show(request, reply, source.id, { kind: 'error', message: message(err) });
      } finally {
        await dir?.close();
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Body }>(
    '/account/admin/directories/:id/preview',
    async (request, reply) => {
      if (!(await guardPost(request, reply))) return;
      const source = await sources.get(request.params.id);
      if (!source) return reply.code(404).send();
      let dir: Directory | undefined;
      try {
        dir = await Directory.connect(source.config, await sources.secret(source.id));
        const person = await dir.findPerson((request.body?.login ?? '').trim().slice(0, 256));
        if (!person)
          return show(request, reply, source.id, {
            kind: 'preview',
            person: null,
            role: null,
            groups: [],
          });
        const [isAdmin, isGuest, groups] = await Promise.all([
          dir.matches(person.dn, source.config.adminFilter),
          dir.matches(person.dn, source.config.guestFilter),
          dir.groupsOf(person),
        ]);
        return show(request, reply, source.id, {
          kind: 'preview',
          person,
          role: isAdmin ? 'admin' : isGuest ? 'guest' : null,
          groups: groups.map((g) => g.name).sort(),
        });
      } catch (err) {
        return show(request, reply, source.id, { kind: 'error', message: message(err) });
      } finally {
        await dir?.close();
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/account/admin/directories/:id/sync',
    async (request, reply) => {
      const me = await guardPost(request, reply);
      if (!me) return;
      const source = await sources.get(request.params.id);
      if (!source) return reply.code(404).send();
      try {
        const c = await syncSource(opts.pool, sources, source, 'manual');
        await audit.record('admin.directory.synced', me.id, request.ip, {
          source: source.id,
          ...c,
        });
        return show(request, reply, source.id, {
          kind: 'synced',
          seen: c.usersSeen,
          created: c.usersCreated,
          updated: c.usersUpdated,
          deactivated: c.usersDeactivated,
          skipped: c.usersSkipped,
        });
      } catch (err) {
        const text = err instanceof DirectoryError ? err.message : message(err);
        return show(request, reply, source.id, { kind: 'error', message: text });
      }
    },
  );

  // --- identity providers -------------------------------------------------

  const providers = opts.providers;
  if (!providers) return;

  async function validateProvider(form: ProviderForm, id?: string) {
    const schema = form.kind === 'oidc' ? oidcConfigSchema : samlConfigSchema;
    const parsed = schema.safeParse(form.config);
    const fields = new Set<string>();
    if (!form.name || form.name.length > 100) fields.add('name');
    // Apps see a provider's groups by its name ("/" as "-"): two providers
    // never share that prefix.
    if (form.name && (await providers!.nameTaken(form.name, id))) fields.add('name');
    if (!parsed.success) for (const issue of parsed.error.issues) fields.add(String(issue.path[0]));
    return parsed.success && fields.size === 0 ? { config: parsed.data } : { fields: [...fields] };
  }

  app.get('/account/admin/providers', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const list = await providers.list();
    return page(
      reply,
      200,
      providersPage({
        locale: locale(request),
        providers: await Promise.all(
          list.map(async (p) => ({ ...p, people: await providers.people(p.id) })),
        ),
      }),
    );
  });

  const kindOf = (v: string | undefined): ProviderKind => (v === 'saml' ? 'saml' : 'oidc');

  app.get<{ Querystring: { kind?: string } }>(
    '/account/admin/providers/new',
    async (request, reply) => {
      if (!(await admin(request, reply))) return;
      const kind = kindOf(request.query.kind);
      const defaults =
        kind === 'oidc'
          ? oidcConfigSchema.partial().parse({})
          : samlConfigSchema.partial().parse({});
      return page(
        reply,
        200,
        providerPage({
          locale: locale(request),
          issuer,
          form: { kind, name: '', enabled: true, hasSecret: false, config: defaults },
        }),
      );
    },
  );

  app.post<{ Querystring: { kind?: string }; Body: Body }>(
    '/account/admin/providers/new',
    async (request, reply) => {
      const me = await guardPost(request, reply);
      if (!me) return;
      const form = providerFormOf(kindOf(request.query.kind), request.body ?? {}, false);
      const v = await validateProvider(form);
      if ('fields' in v) {
        return page(
          reply,
          400,
          providerPage({ locale: locale(request), issuer, form, invalid: v.fields }),
        );
      }
      const created = await providers.create({
        kind: form.kind,
        name: form.name,
        config: v.config,
        enabled: form.enabled,
        secret: request.body?.clientSecret ?? '',
      });
      await audit.record('admin.provider.created', me.id, request.ip, {
        provider: created.id,
        kind: form.kind,
        name: form.name,
      });
      return reply.redirect(`/account/admin/providers/${created.id}?saved=1`, 303);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { saved?: string; scim_stopped?: string } }>(
    '/account/admin/providers/:id',
    async (request, reply) => {
      if (!(await admin(request, reply))) return;
      const p = await providers.get(request.params.id);
      if (!p) return reply.code(404).send();
      return page(
        reply,
        200,
        providerPage({
          locale: locale(request),
          issuer,
          id: p.id,
          form: {
            kind: p.kind,
            name: p.name,
            enabled: p.enabled,
            hasSecret: p.hasSecret,
            config: p.config,
          },
          saved: Boolean(request.query.saved),
          scim: { since: p.scimSince, stopped: Boolean(request.query.scim_stopped) },
        }),
      );
    },
  );

  // SCIM provisioning: a new token is shown once, on the page this answers with.
  app.post<{ Params: { id: string } }>(
    '/account/admin/providers/:id/scim/token',
    async (request, reply) => {
      const me = await guardPost(request, reply);
      if (!me) return;
      const p = await providers.get(request.params.id);
      if (!p) return reply.code(404).send();
      const token = await providers.newScimToken(p.id);
      await audit.record('admin.provider.scim_token', me.id, request.ip, { provider: p.id });
      const fresh = (await providers.get(p.id))!;
      return page(
        reply,
        200,
        providerPage({
          locale: locale(request),
          issuer,
          id: p.id,
          form: {
            kind: fresh.kind,
            name: fresh.name,
            enabled: fresh.enabled,
            hasSecret: fresh.hasSecret,
            config: fresh.config,
          },
          scim: { since: fresh.scimSince, token },
        }),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    '/account/admin/providers/:id/scim/stop',
    async (request, reply) => {
      const me = await guardPost(request, reply);
      if (!me) return;
      const p = await providers.get(request.params.id);
      if (!p) return reply.code(404).send();
      await providers.stopScim(p.id);
      await audit.record('admin.provider.scim_stopped', me.id, request.ip, { provider: p.id });
      return reply.redirect(`/account/admin/providers/${p.id}?scim_stopped=1`, 303);
    },
  );

  app.post<{ Params: { id: string }; Body: Body }>(
    '/account/admin/providers/:id',
    async (request, reply) => {
      const me = await guardPost(request, reply);
      if (!me) return;
      const p = await providers.get(request.params.id);
      if (!p) return reply.code(404).send();
      const form = providerFormOf(p.kind, request.body ?? {}, p.hasSecret);
      const v = await validateProvider(form, p.id);
      if ('fields' in v) {
        return page(
          reply,
          400,
          providerPage({ locale: locale(request), issuer, id: p.id, form, invalid: v.fields }),
        );
      }
      const secret = request.body?.clientSecret ?? '';
      // The saved secret goes only to the issuer and client id it was
      // entered for: changing them needs it again.
      if (!secret && p.hasSecret && !sameSecretTarget(p.config, v.config)) {
        return page(
          reply,
          400,
          providerPage({
            locale: locale(request),
            issuer,
            id: p.id,
            form: { ...form, hasSecret: false },
            invalid: ['clientSecret'],
          }),
        );
      }
      await providers.update(p.id, {
        name: form.name,
        config: v.config,
        enabled: form.enabled,
        ...(secret ? { secret } : {}),
      });
      // Turned off: its people are signed out of Cenacle ID.
      if (p.enabled && !form.enabled) await endProviderSessions(opts.pool, p.id);
      await audit.record('admin.provider.updated', me.id, request.ip, { provider: p.id });
      return reply.redirect(`/account/admin/providers/${p.id}?saved=1`, 303);
    },
  );
}
