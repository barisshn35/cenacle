// SPDX-License-Identifier: Apache-2.0
// The directory feed: apps registered with directory_feed (the chat) read the
// accounts that changed since a cursor, to follow names, groups, roles and
// deactivations without waiting for the next sign-in.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ClientMetadata } from '../oidc/clients.ts';

const PAGE = 500;

function authorized(header: string | undefined, clients: ClientMetadata[]): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  // RFC 6749 2.3.1: id and secret are form-encoded in Basic credentials.
  const id = decodeURIComponent(decoded.slice(0, sep).replace(/\+/g, ' '));
  const secret = Buffer.from(decodeURIComponent(decoded.slice(sep + 1).replace(/\+/g, ' ')));
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
    // Cursor: "<updated_at>|<id>" of the last account seen.
    const [at, id] = (request.query.after ?? '').split('|');
    const valid = at && id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(Date.parse(at));
    // Changes of the last two seconds wait for the next call: a transaction
    // still committing could otherwise slip behind the cursor.
    const { rows } = await opts.pool.query(
      `SELECT u.id, u.updated_at::text AS cursor_at, u.display_name, u.email, u.email_verified, u.username,
              u.directory_role, u.disabled_at IS NOT NULL AS disabled,
              coalesce((SELECT encode(sha256(p.data), 'hex') FROM user_photos p
                        WHERE p.user_id = u.id AND p.origin = 'directory'), '') AS picture,
              coalesce((SELECT array_agg(g.name ORDER BY g.name) FROM user_groups ug
                        JOIN directory_groups g ON g.id = ug.group_id WHERE ug.user_id = u.id), '{}') AS groups
       FROM users u
       WHERE u.updated_at < now() - interval '2 seconds'
         AND ($1::timestamptz IS NULL OR (u.updated_at, u.id) > ($1::timestamptz, $2::uuid))
       ORDER BY u.updated_at, u.id
       LIMIT $3`,
      [valid ? at : null, valid ? id : null, PAGE + 1],
    );
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return reply.header('cache-control', 'no-store').send({
      users: page.map((r) => ({
        sub: r.id,
        name: r.display_name,
        email: r.email ?? '',
        email_verified: r.email ? r.email_verified : false,
        preferred_username: r.username ?? '',
        groups: r.groups,
        cenacle_role: r.directory_role ?? '',
        disabled: r.disabled,
        // The directory's photo (SHA-256), read at /directory/v1/photos/<sub>.
        picture: r.picture,
      })),
      next: last ? `${last.cursor_at}|${last.id}` : (request.query.after ?? ''),
      more: rows.length > PAGE,
    });
  });
}
