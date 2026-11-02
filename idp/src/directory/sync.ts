// SPDX-License-Identifier: AGPL-3.0-only
// Synchronization with directories, and signing in with a directory password.
import type pg from 'pg';
import { Directory, memberships, verifyPassword, type DirectoryPerson } from './ldap.ts';
import {
  deactivateMissing,
  ensureGroups,
  upsertGroups,
  upsertPerson,
  type Role,
  type Source,
  type SourceStore,
  type SyncCounts,
} from './store.ts';

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

function roleOf(dn: string, admins: Set<string>, guests: Set<string>): Role {
  const key = dn.toLowerCase();
  if (admins.has(key)) return 'admin';
  if (guests.has(key)) return 'guest';
  return null;
}

function describe(err: unknown): string {
  if ((err as { code?: string }).code === '23505')
    return 'another account has this sign-in name or e-mail address';
  return err instanceof Error ? err.message : String(err);
}

/** Reads every person and group of a directory and brings Cenacle ID up to date. */
export async function syncSource(
  pool: pg.Pool,
  sources: SourceStore,
  source: Source,
  trigger: 'schedule' | 'manual',
): Promise<SyncCounts> {
  const run = await sources.startRun(source.id, trigger);
  let dir: Directory | undefined;
  try {
    dir = await Directory.connect(source.config, await sources.secret(source.id));
    const people = await dir.listPeople();
    // A directory that suddenly returns nobody is more likely broken than empty:
    // keep everyone rather than deactivating the whole company.
    if (people.length === 0)
      throw new Error('The directory returned no people; nobody was changed.');
    const groups = await dir.listGroups();
    const admins = await dir.matching(source.config.adminFilter);
    const guests = await dir.matching(source.config.guestFilter);
    const member = memberships(people, groups, source.config.groupMembership);
    const groupIds = await upsertGroups(pool, source.id, groups);
    const counts: SyncCounts = {
      usersSeen: people.length,
      usersCreated: 0,
      usersUpdated: 0,
      usersDeactivated: 0,
      usersSkipped: 0,
      groups: groups.length,
    };
    const skipped: string[] = [];
    for (const p of people) {
      const ids = [...(member.get(p.externalId) ?? [])]
        .map((g) => groupIds.get(g)!)
        .filter(Boolean);
      let r;
      try {
        r = await upsertPerson(
          pool,
          source.id,
          p,
          roleOf(p.dn, admins, guests),
          ids,
          source.config.linkByEmail,
        );
      } catch (err) {
        // One person Cenacle ID cannot keep (their sign-in name belongs to
        // another account) is skipped and reported: the others, and the
        // deactivation of people no longer listed, go on.
        counts.usersSkipped++;
        skipped.push(`${p.username || p.externalId}: ${describe(err)}`);
        continue;
      }
      if (r.created) counts.usersCreated++;
      else if (r.changed) counts.usersUpdated++;
    }
    // Skipped people are still listed: never deactivated for it.
    counts.usersDeactivated = await deactivateMissing(
      pool,
      source.id,
      people.map((p) => p.externalId),
    );
    await sources.finishRun(run, source.id, counts, '', skipped.join('; '));
    return counts;
  } catch (err) {
    await sources.finishRun(run, source.id, null, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await dir?.close();
  }
}

/**
 * Runs due synchronizations every minute. One instance does it at a time (a
 * PostgreSQL advisory lock); the others skip the round.
 */
export function scheduleSync(pool: pg.Pool, sources: SourceStore, log: Log): NodeJS.Timeout {
  const tick = async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('cenacle-idp-directory-sync')) AS ok`,
      );
      if (!rows[0]?.ok) return;
      try {
        for (const source of await sources.due()) {
          try {
            const counts = await syncSource(pool, sources, source, 'schedule');
            log.info({ source: source.name, ...counts }, 'directory synchronized');
          } catch (err) {
            log.warn({ source: source.name, err }, 'directory synchronization failed');
          }
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('cenacle-idp-directory-sync'))`);
      }
    } finally {
      client.release();
    }
  };
  const timer = setInterval(() => void tick().catch(() => undefined), 60_000);
  timer.unref();
  void tick().catch(() => undefined);
  return timer;
}

/**
 * Signs a person in with their directory password: finds them by the login
 * attribute, binds as them, then refreshes their account (name, address,
 * title, role, groups, photo). Returns the account id or null.
 */
export async function signInWithDirectory(
  pool: pg.Pool,
  sources: SourceStore,
  login: string,
  password: string,
): Promise<string | null> {
  if (!login || !password) return null;
  for (const source of await sources.list()) {
    if (!source.enabled) continue;
    let dir: Directory | undefined;
    try {
      dir = await Directory.connect(source.config, await sources.secret(source.id));
      const person: DirectoryPerson | null = await dir.findPerson(login);
      if (!person) continue;
      if (!(await verifyPassword(dir, person, password))) return null;
      const [isAdmin, isGuest] = await Promise.all([
        dir.matches(person.dn, source.config.adminFilter),
        dir.matches(person.dn, source.config.guestFilter),
      ]);
      const groups = await dir.groupsOf(person);
      const groupIds = await ensureGroups(pool, source.id, groups);
      const r = await upsertPerson(
        pool,
        source.id,
        person,
        isAdmin ? 'admin' : isGuest ? 'guest' : null,
        groupIds,
        source.config.linkByEmail,
      );
      return r.id;
    } finally {
      await dir?.close();
    }
  }
  return null;
}
