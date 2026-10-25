// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { dateLocale } from '../../i18n/time-format';
import { setConnectionPolicy, type FederationConnection } from './federation';

type Policy = components['schemas']['ConnectionPolicy'];
type AuditEvent = components['schemas']['AuditEvent'];

const TAKES = ['receive_messages', 'receive_reactions', 'receive_edits'] as const;

/** What this server takes in from a connection, and how often it may send. */
export function ConnectionPolicyForm({
  connection,
  onSaved,
}: {
  connection: FederationConnection;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [policy, setPolicy] = useState<Policy>(
    connection.policy ?? {
      receive_messages: true,
      receive_reactions: true,
      receive_edits: true,
      requests_per_minute: 120,
    },
  );
  const save = useMutation({
    mutationFn: () => setConnectionPolicy(connection.id, policy),
    onSuccess: () => {
      toast.success(t('federation.policy.saved'));
      onSaved();
    },
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('federation.failed')),
  });
  return (
    <details className="group text-sm" data-testid="connection-policy">
      <summary className="flex min-h-target cursor-pointer items-center text-xs font-medium text-muted-foreground">
        {t('federation.policy.title')}
      </summary>
      <form
        className="flex flex-col gap-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {TAKES.map((key) => (
          <label key={key} className="flex min-h-target items-center gap-2.5">
            <input
              type="checkbox"
              className="size-target shrink-0 accent-primary"
              checked={policy[key]}
              onChange={(e) => setPolicy((p) => ({ ...p, [key]: e.target.checked }))}
            />
            {t(`federation.policy.${key}`)}
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-rate`}>{t('federation.policy.rate')}</Label>
          <Input
            id={`${id}-rate`}
            type="number"
            min={1}
            max={6000}
            className="w-24"
            value={policy.requests_per_minute}
            onChange={(e) =>
              setPolicy((p) => ({ ...p, requests_per_minute: Number(e.target.value) || 1 }))
            }
          />
        </div>
        <div>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {t('federation.policy.save')}
          </Button>
        </div>
      </form>
    </details>
  );
}

/** The federation entries of the workspace's audit log, newest first. */
export function FederationActivity({ ws }: { ws: string }) {
  const { t, i18n } = useTranslation();
  const activity = useQuery({
    queryKey: ['federation-activity', ws],
    queryFn: () =>
      apiFetch<{ events: AuditEvent[] }>(`/api/workspaces/${ws}/audit?prefix=federation.&limit=20`),
  });
  const time = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const describe = (e: AuditEvent) => {
    const d = e.detail as { change?: string; name?: string; server?: string };
    if (e.action === 'federation.refused')
      return t('federation.activity.refused', { server: d.server ?? '' });
    return t(`federation.activity.${d.change ?? 'changed'}`, {
      name: d.name ?? '',
      defaultValue: t('federation.activity.changed', { name: d.name ?? '' }),
    });
  };
  if (activity.isPending) return <Skeleton className="h-16" />;
  const events = activity.data?.events ?? [];
  return events.length === 0 ? (
    <p className="text-sm text-muted-foreground">{t('federation.activity.none')}</p>
  ) : (
    <ul className="flex flex-col gap-1.5 text-sm" data-testid="federation-activity">
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap gap-x-2">
          <span>{describe(e)}</span>
          <span className="text-muted-foreground">
            {e.actor ? `${e.actor.display_name} · ` : ''}
            {time.format(new Date(e.at))}
          </span>
        </li>
      ))}
    </ul>
  );
}
