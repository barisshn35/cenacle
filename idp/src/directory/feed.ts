// SPDX-License-Identifier: AGPL-3.0-only
// The directory feed: apps registered with directory_feed (the chat) read the
// accounts that changed since a cursor, to follow names, groups, roles and
// deactivations without waiting for the next sign-in.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ClientMetadata } from '../oidc/clients.ts';
import { APP_GROUPS_SQL } from './store.ts';

const PAGE = 500;

function authorized(header: string | undefined, clients: ClientMetadata[]): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  // RFC 6749 2.3.1: id and secret are form-encoded in Basic credentials.
  // Malformed encoding (a lone %) is a wrong credential, not a server error.
  let id: string;
  let secret: Buffer;
  try {
    id = decodeURIComponent(decoded.slice(0, sep).replace(/\+/g, ' '));
    secret = Buffer.from(decodeURIComponent(decoded.slice(sep + 1).replace(/\+/g, ' ')));
  } catch {
    return false;
  }
  const client = clients.find((c) => c.client_id === id && c.cenacle_directory);
  if (!client) return false;
  const want = Buffer.from(client.client_secret);
  return want.length === secret.length && timingSafeEqual(want, secret);
}

export function registerDirectoryFeed(
  app: FastifyInstance,
  opts: { pool: pg.Pool; clients: ClientMetadata[] },
) {
  app.get<{ Params: { sub: string } }>('/directory/v1/photos/:sub', async (request, reply) => {
    if (!authorized(request.headers.authorization, opts.clients)) {
      return reply.code(401).header('www-authenticate', 'Basic realm="cenacle-id"').send();
    }
    if (!/^[0-9a-f-]{36}$/i.test(request.params.sub)) return reply.code(404).send();
    const { rows } = await opts.pool.query<{ content_type: string; data: Buffer }>(
      `SELECT content_type, data FROM user_photos WHERE user_id = $1 AND origin = 'directory'`,
      [request.params.sub],
    );
    const photo = rows[0];
    if (!photo) return reply.code(404).send();
    return reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .type(photo.content_type)
      .send(photo.data);
  });

  app.get<{ Querystring: { after?: string } }>('/directory/v1/changes', async (request, reply) => {
    if (!authorized(request.headers.authorization, opts.clients)) {
      return reply.code(401).header('www-authenticate', 'Basic realm="cenacle-id"').send();
    }
    // Cursor: "<updated_at>|<id>" of the last account seen. Deleted accounts
    // (their tombstones) come in the same order, by the time of the deletion.
    const [at, id] = (request.query.after ?? '').split('|');
    const valid = at && id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(Date.parse(at));
    // Changes of the last two seconds wait for the next call: a transaction
    // still committing could otherwise slip behind the cursor.
    const { rows } = await opts.pool.query(
      `WITH page AS (
         SELECT * FROM (
           SELECT u.id, u.updated_at AS at, false AS deleted FROM users u
           WHERE u.updated_at < now() - interval '2 seconds'
             AND ($1::timestamptz IS NULL OR (u.updated_at, u.id) > ($1::timestamptz, $2::uuid))
           UNION ALL
           SELECT d.id, d.deleted_at, true FROM deleted_accounts d
           WHERE d.deleted_at < now() - interval '2 seconds'
             AND ($1::timestamptz IS NULL OR (d.deleted_at, d.id) > ($1::timestamptz, $2::uuid))
         ) changes ORDER BY at, id LIMIT $3)
       SELECT p.id, p.at::text AS cursor_at, p.deleted, p.at AS deleted_at, u.display_name, u.email,
              u.email_verified, u.username, u.directory_role,
              (u.disabled_at IS NOT NULL OR u.admin_disabled_at IS NOT NULL) AS disabled,
              u.sessions_ended_at,
              coalesce((SELECT encode(sha256(ph.data), 'hex') FROM user_photos ph
                        WHERE ph.user_id = u.id AND ph.origin = 'directory'), '') AS picture,
              coalesce((SELECT array_agg(n ORDER BY n) FROM (${APP_GROUPS_SQL.replace('$1', 'u.id')}) ag), '{}') AS groups
       FROM page p LEFT JOIN users u ON u.id = p.id AND NOT p.deleted
       ORDER BY p.at, p.id`,
      [valid ? at : null, valid ? id : null, PAGE + 1],
    );
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return reply.header('cache-control', 'no-store').send({
      users: page.map((r) =>
        r.deleted
          ? // A deleted account: the app deactivates it and ends its sessions.
            {
              sub: r.id,
              name: '',
              email: '',
              email_verified: false,
              preferred_username: '',
              groups: [],
              cenacle_role: '',
              disabled: true,
              sessions_ended_at: new Date(r.deleted_at).toISOString(),
              picture: '',
            }
          : {
              sub: r.id,
              name: r.display_name,
              email: r.email ?? '',
              email_verified: r.email ? r.email_verified : false,
              preferred_username: r.username ?? '',
              groups: r.groups,
              cenacle_role: r.directory_role ?? '',
              disabled: r.disabled,
              // Sessions the app made before this time end (a two-step reset, for one).
              sessions_ended_at: r.sessions_ended_at
                ? new Date(r.sessions_ended_at).toISOString()
                : '',
              // The directory's photo (SHA-256), read at /directory/v1/photos/<sub>.
              picture: r.picture,
            },
      ),
      next: last ? `${last.cursor_at}|${last.id}` : (request.query.after ?? ''),
      more: rows.length > PAGE,
    });
  });

  // Changes of the names apps see for groups (ADR 0046), oldest first, so an
  // app's group mappings follow them; read before the changed people.
  app.get<{ Querystring: { after?: string } }>(
    '/directory/v1/group-renames',
    async (request, reply) => {
      if (!authorized(request.headers.authorization, opts.clients)) {
        return reply.code(401).header('www-authenticate', 'Basic realm="cenacle-id"').send();
      }
      const raw = request.query.after ?? '';
      const after = /^\d{1,18}$/.test(raw) ? raw : '0';
      // As above: changes of the last two seconds wait for the next call.
      const { rows } = await opts.pool.query<{
        id: string;
        old_name: string;
        new_name: string;
        ambiguous: boolean;
      }>(
        `SELECT id::text, old_name, new_name, ambiguous FROM group_name_changes
         WHERE id > $1::bigint AND created_at < now() - interval '2 seconds'
         ORDER BY group_name_changes.id LIMIT $2`,
        [after, PAGE + 1],
      );
      const page = rows.slice(0, PAGE);
      return reply.header('cache-control', 'no-store').send({
        renames: page.map((r) => ({
          id: r.id,
          old: r.old_name,
          new: r.new_name,
          ambiguous: r.ambiguous,
        })),
        next: page.at(-1)?.id ?? after,
        more: rows.length > PAGE,
      });
    },
  );
}
