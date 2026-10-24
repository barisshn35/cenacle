// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';

/** What the audit log records about accounts. */
export type AuditAction =
  | 'signin.succeeded'
  | 'signin.failed'
  | 'signin.second_step_failed'
  | 'signin.passkey_failed'
  | 'signin.federation_failed'
  | 'passkey.added'
  | 'account.name_changed'
  | 'passkey.removed'
  | 'recovery_code.used'
  | 'two_step.enabled'
  | 'two_step.disabled'
  | 'recovery_codes.regenerated'
  | 'account.signed_in'
  | 'account.signed_out'
  | 'admin.account.disable'
  | 'admin.account.enable'
  | 'admin.account.reset_two_step'
  | 'admin.account.make_admin'
  | 'admin.account.remove_admin'
  | 'admin.directory.created'
  | 'admin.directory.updated'
  | 'admin.directory.synced'
  | 'admin.provider.created'
  | 'admin.provider.updated'
  | 'admin.sign_in_policy.changed'
  | 'admin.provider.scim_token'
  | 'admin.provider.scim_stopped'
  | 'scim.user.created'
  | 'scim.user.updated'
  | 'scim.user.deactivated'
  | 'scim.user.deleted'
  | 'scim.group.changed';

export interface AuditEvent {
  id: string;
  at: Date;
  userId: string | null;
  action: AuditAction;
  ip: string;
  detail: Record<string, unknown>;
}

/**
 * The audit log: who did what with an account, when and from where. Writing
 * never fails the request it belongs to; a failure is logged instead.
 */
export class AuditLog {
  constructor(
    private readonly pool: pg.Pool,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async record(
    action: AuditAction,
    userId: string | null,
    ip: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO audit_events (user_id, action, ip, detail) VALUES ($1, $2, $3, $4)',
        [userId, action, ip, JSON.stringify(detail)],
      );
    } catch (err) {
      this.onError(err);
    }
  }

  /** A user's events, newest first. */
  async forUser(userId: string, limit = 20): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query<{
      id: string;
      at: Date;
      user_id: string | null;
      action: AuditAction;
      ip: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT id, at, user_id, action, ip, detail FROM audit_events
       WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      userId: r.user_id,
      action: r.action,
      ip: r.ip,
      detail: r.detail,
    }));
  }
}
