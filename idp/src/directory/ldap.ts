// SPDX-License-Identifier: Apache-2.0
// LDAP / Active Directory: checking passwords by binding as the person, and
// reading people and groups for synchronization. Values from users are always
// escaped in filters (RFC 4515).
import { isIP } from 'node:net';
import { Client, escapeFilter, type Entry } from 'ldapts';
import { z } from 'zod';

/** Settings of a directory (the bind password is kept apart, encrypted). */
export const ldapConfigSchema = z.object({
  /** Tried in order (failover): ldap://host:389, ldaps://host:636, a Global Catalog on 3268/3269. */
  urls: z
    .array(z.string().regex(/^ldaps?:\/\/[^/\s]+\/?$/))
    .min(1)
    .max(5),
  startTls: z.boolean().default(false),
  /** PEM certificates trusted for ldaps:// and StartTLS (besides the system ones). */
  caCert: z.string().max(20_000).default(''),
  /** The service account that reads the directory ('' for an anonymous read). */
  bindDn: z.string().max(500).default(''),
  baseDn: z.string().min(1).max(500),
  /** Who may sign in; excludes disabled accounts. */
  userFilter: z.string().min(3).max(2000),
  /** What people type to sign in: sAMAccountName, userPrincipalName, mail, uid. */
  loginAttribute: z.string().min(1).max(100),
  /** The stable id: objectGUID (Active Directory), entryUUID (OpenLDAP). */
  idAttribute: z.string().min(1).max(100),
  nameAttribute: z.string().max(100).default('displayName'),
  firstNameAttribute: z.string().max(100).default('givenName'),
  lastNameAttribute: z.string().max(100).default('sn'),
  emailAttribute: z.string().max(100).default('mail'),
  titleAttribute: z.string().max(100).default('title'),
  photoAttribute: z.string().max(100).default('thumbnailPhoto'),
  groupBaseDn: z.string().max(500).default(''),
  groupFilter: z.string().max(2000).default(''),
  groupNameAttribute: z.string().max(100).default('cn'),
  groupIdAttribute: z.string().max(100).default('objectGUID'),
  /** member: groups list member DNs (nested groups resolved); memberUid: posixGroup. */
  groupMembership: z.enum(['member', 'memberUid']).default('member'),
  memberAttribute: z.string().max(100).default('member'),
  /** People matching it are administrators (or guests) in Cenacle. */
  adminFilter: z.string().max(2000).default(''),
  guestFilter: z.string().max(2000).default(''),
  timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
});
export type LdapConfig = z.infer<typeof ldapConfigSchema>;

/** Starting points for the two common directories. */
export const PRESETS: Record<'active_directory' | 'openldap', Partial<LdapConfig>> = {
  active_directory: {
    userFilter:
      '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))',
    loginAttribute: 'sAMAccountName',
    idAttribute: 'objectGUID',
    photoAttribute: 'thumbnailPhoto',
    groupFilter: '(objectClass=group)',
    groupIdAttribute: 'objectGUID',
    groupMembership: 'member',
    memberAttribute: 'member',
  },
  openldap: {
    userFilter: '(objectClass=inetOrgPerson)',
    loginAttribute: 'uid',
    idAttribute: 'entryUUID',
    photoAttribute: 'jpegPhoto',
    groupFilter:
      '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))',
    groupIdAttribute: 'entryUUID',
    groupMembership: 'member',
    memberAttribute: 'member',
  },
};

/** A person as the directory describes them. */
export interface DirectoryPerson {
  dn: string;
  externalId: string;
  username: string;
  displayName: string;
  email: string | null;
  title: string | null;
  photo: Buffer | null;
  /** Values of the login attribute ("uid", for memberUid groups). */
  uid: string;
}

export interface DirectoryGroup {
  dn: string;
  externalId: string;
  name: string;
  /** Member DNs (member mode) or uids (memberUid mode). */
  members: string[];
}

export class DirectoryError extends Error {
  constructor(
    readonly code: 'unreachable' | 'bind_failed' | 'search_failed' | 'not_unique' | 'config',
    message: string,
  ) {
    super(message);
    this.name = 'DirectoryError';
  }
}

const BINARY_IDS = new Set(['objectguid', 'objectsid']);

function first(entry: Entry, attr: string): string | Buffer | undefined {
  if (!attr) return undefined;
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attr.toLowerCase());
  const v = key ? entry[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function text(entry: Entry, attr: string): string {
  const v = first(entry, attr);
  if (v === undefined) return '';
  return (Buffer.isBuffer(v) ? v.toString('utf8') : v).trim();
}

function all(entry: Entry, attr: string): string[] {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attr.toLowerCase());
  const v = key ? entry[key] : undefined;
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x));
}

/** The stable id of an entry: binary GUIDs as lowercase hex. */
function idOf(entry: Entry, attr: string): string {
  const v = first(entry, attr);
  if (v === undefined) return '';
  if (Buffer.isBuffer(v)) return v.toString('hex');
  return v.trim();
}

/** A connection to the directory, bound as the service account. */
export class Directory {
  private constructor(
    private readonly client: Client,
    readonly config: LdapConfig,
  ) {}

  static async connect(config: LdapConfig, password: string): Promise<Directory> {
    let last: unknown;
    for (const url of config.urls) {
      const client = newClient(config, url);
      try {
        if (config.startTls && url.startsWith('ldap://'))
          await client.startTLS(tlsOptions(config, url));
        if (config.bindDn) await client.bind(config.bindDn, password);
        return new Directory(client, config);
      } catch (err) {
        last = err;
        await client.unbind().catch(() => undefined);
        if (isInvalidCredentials(err)) {
          throw new DirectoryError(
            'bind_failed',
            'The service account was rejected by the directory.',
          );
        }
      }
    }
    throw new DirectoryError('unreachable', `No directory server answered: ${describe(last)}`);
  }

  async close(): Promise<void> {
    await this.client.unbind().catch(() => undefined);
  }

  private personAttributes(): string[] {
    const c = this.config;
    return [
      c.idAttribute,
      c.loginAttribute,
      c.nameAttribute,
      c.firstNameAttribute,
      c.lastNameAttribute,
      c.emailAttribute,
      c.titleAttribute,
      c.photoAttribute,
      'cn',
      'uid',
    ].filter(Boolean);
  }

  private buffers(): string[] {
    const c = this.config;
    return [c.photoAttribute, c.idAttribute, c.groupIdAttribute].filter(
      (a) => a && (BINARY_IDS.has(a.toLowerCase()) || a === c.photoAttribute),
    );
  }

  toPerson(entry: Entry): DirectoryPerson | null {
    const c = this.config;
    const externalId = idOf(entry, c.idAttribute);
    const username = text(entry, c.loginAttribute);
    if (!externalId || !username) return null;
    const given = text(entry, c.firstNameAttribute);
    const family = text(entry, c.lastNameAttribute);
    // The name is always the directory's: displayName, else given and family
    // name, else cn.
    const displayName =
      text(entry, c.nameAttribute) ||
      [given, family].filter(Boolean).join(' ') ||
      text(entry, 'cn') ||
      username;
    const photo = first(entry, c.photoAttribute);
    return {
      dn: entry.dn,
      externalId,
      username,
      displayName: displayName.slice(0, 200),
      email: text(entry, c.emailAttribute) || null,
      title: text(entry, c.titleAttribute) || null,
      photo: Buffer.isBuffer(photo) && photo.length > 0 && photo.length <= 2_000_000 ? photo : null,
      uid: text(entry, 'uid') || username,
    };
  }

  /** The person who signs in with this name, or null (none, or more than one). */
  async findPerson(login: string): Promise<DirectoryPerson | null> {
    const c = this.config;
    const entries = await this.search(c.baseDn, personFilter(c, login), this.personAttributes());
    if (entries.length !== 1) return null;
    return this.toPerson(entries[0]!);
  }

  /** Whether an entry (by DN) matches a filter (admin and guest filters). */
  async matches(dn: string, filter: string): Promise<boolean> {
    if (!filter) return false;
    const entries = await this.search(dn, filter, ['1.1'], 'base').catch(() => []);
    return entries.length === 1;
  }

  /** Every person the user filter admits, read in pages. */
  async listPeople(): Promise<DirectoryPerson[]> {
    const entries = await this.search(
      this.config.baseDn,
      this.config.userFilter,
      this.personAttributes(),
    );
    return entries.map((e) => this.toPerson(e)).filter((p): p is DirectoryPerson => p !== null);
  }

  /** Every group the group filter admits, with its members. */
  async listGroups(): Promise<DirectoryGroup[]> {
    const c = this.config;
    if (!c.groupFilter) return [];
    const memberAttr = c.groupMembership === 'memberUid' ? 'memberUid' : c.memberAttribute;
    const entries = await this.search(c.groupBaseDn || c.baseDn, c.groupFilter, [
      c.groupIdAttribute,
      c.groupNameAttribute,
      memberAttr,
      'memberUid',
    ]);
    return entries
      .map((e) => ({
        dn: e.dn,
        externalId: idOf(e, c.groupIdAttribute) || e.dn.toLowerCase(),
        name: text(e, c.groupNameAttribute) || e.dn,
        // posixGroups list uids even in member mode.
        members: [
          ...all(e, memberAttr),
          ...(memberAttr === 'memberUid' ? [] : all(e, 'memberUid')),
        ],
      }))
      .filter((g) => g.name);
  }

  /** Distinguished names of the people the user filter and another filter both admit. */
  async matching(filter: string): Promise<Set<string>> {
    if (!filter) return new Set();
    const entries = await this.search(this.config.baseDn, `(&${this.config.userFilter}${filter})`, [
      '1.1',
    ]);
    return new Set(entries.map((e) => e.dn.toLowerCase()));
  }

  /**
   * The groups of one person, nested groups included (at sign-in, without
   * reading every group): direct groups first, then the groups that contain
   * those, up to ten levels.
   */
  async groupsOf(person: DirectoryPerson): Promise<DirectoryGroup[]> {
    const c = this.config;
    if (!c.groupFilter) return [];
    const memberAttr = c.groupMembership === 'memberUid' ? 'memberUid' : c.memberAttribute;
    const attrs = [c.groupIdAttribute, c.groupNameAttribute];
    const toGroup = (e: Entry): DirectoryGroup => ({
      dn: e.dn,
      externalId: idOf(e, c.groupIdAttribute) || e.dn.toLowerCase(),
      name: text(e, c.groupNameAttribute) || e.dn,
      members: [],
    });
    const base = c.groupBaseDn || c.baseDn;
    const direct =
      c.groupMembership === 'memberUid'
        ? escapeFilter`(memberUid=${person.uid})`
        : `(|${escapeFilter`(${memberAttr}=${person.dn})`}${escapeFilter`(memberUid=${person.uid})`})`;
    const found = new Map<string, DirectoryGroup>();
    let level = (await this.search(base, `(&${c.groupFilter}${direct})`, attrs)).map(toGroup);
    for (let depth = 0; depth < 10 && level.length > 0; depth++) {
      const fresh = level.filter((g) => !found.has(g.dn.toLowerCase()));
      for (const g of fresh) found.set(g.dn.toLowerCase(), g);
      if (fresh.length === 0 || c.groupMembership === 'memberUid') break;
      const parents = fresh.map((g) => escapeFilter`(${memberAttr}=${g.dn})`).join('');
      level = (await this.search(base, `(&${c.groupFilter}(|${parents}))`, attrs)).map(toGroup);
    }
    return [...found.values()];
  }

  private async search(
    base: string,
    filter: string,
    attributes: string[],
    scope: 'sub' | 'base' = 'sub',
  ) {
    try {
      const { searchEntries } = await this.client.search(base, {
        scope,
        filter,
        attributes,
        explicitBufferAttributes: this.buffers(),
        paged: scope === 'sub' ? { pageSize: 500 } : false,
        timeLimit: Math.ceil(this.config.timeoutMs / 1000),
      });
      return searchEntries;
    } catch (err) {
      throw new DirectoryError('search_failed', `Search under ${base} failed: ${describe(err)}`);
    }
  }
}

function personFilter(c: LdapConfig, login: string): string {
  return `(&${c.userFilter}(${c.loginAttribute}=${escapeFilter`${login}`}))`;
}

function newClient(config: LdapConfig, url: string): Client {
  return new Client({
    url,
    timeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
    // ldapts uses TLS whenever tlsOptions are given: only for ldaps://.
    ...(url.startsWith('ldaps://') ? { tlsOptions: tlsOptions(config, url) } : {}),
    strictDN: false,
  });
}

function tlsOptions(config: LdapConfig, url: string) {
  const host = new URL(url).hostname;
  return {
    // SNI takes names only, not addresses.
    ...(isIP(host.replace(/^\[|\]$/g, '')) ? {} : { servername: host }),
    minVersion: 'TLSv1.2' as const,
    ...(config.caCert ? { ca: [config.caCert] } : {}),
  };
}

function isInvalidCredentials(err: unknown): boolean {
  return (err as { code?: number }).code === 49;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Checks a person's password by binding as them. Empty passwords are refused
 * before anything is sent (an empty password is an anonymous bind, which many
 * servers accept).
 */
export async function verifyPassword(
  dir: Directory,
  person: DirectoryPerson,
  password: string,
): Promise<boolean> {
  if (!password || password.length > 1024) return false;
  for (const url of dir.config.urls) {
    const client = newClient(dir.config, url);
    try {
      if (dir.config.startTls && url.startsWith('ldap://'))
        await client.startTLS(tlsOptions(dir.config, url));
      await client.bind(person.dn, password);
      return true;
    } catch (err) {
      if (isInvalidCredentials(err)) return false;
      // Unreachable: try the next server.
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
  throw new DirectoryError('unreachable', 'No directory server answered.');
}

/**
 * Resolves who is in which group, nested groups included: a person is in a
 * group when they (or a group they are in) are listed as its member.
 */
export function memberships(
  people: DirectoryPerson[],
  groups: DirectoryGroup[],
  mode: LdapConfig['groupMembership'],
) {
  const byDn = new Map(groups.map((g) => [g.dn.toLowerCase(), g]));
  // For each group, the groups that contain it.
  const parents = new Map<string, DirectoryGroup[]>();
  for (const g of groups) {
    for (const m of g.members) {
      const child = byDn.get(m.toLowerCase());
      if (child)
        parents.set(child.dn.toLowerCase(), [...(parents.get(child.dn.toLowerCase()) ?? []), g]);
    }
  }
  const result = new Map<string, Set<string>>(); // person externalId -> group externalIds
  for (const p of people) {
    const direct = groups.filter((g) =>
      g.members.some((m) => {
        const v = m.toLowerCase();
        return (
          v === p.dn.toLowerCase() ||
          (mode === 'memberUid' || !m.includes('=') ? v === p.uid.toLowerCase() : false)
        );
      }),
    );
    const seen = new Set<string>();
    const queue = [...direct];
    while (queue.length) {
      const g = queue.shift()!;
      if (seen.has(g.externalId)) continue;
      seen.add(g.externalId);
      queue.push(...(parents.get(g.dn.toLowerCase()) ?? []));
    }
    result.set(p.externalId, seen);
  }
  return result;
}
