// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CopyIcon, GlobeIcon, Link2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { useActiveWorkspace } from '../chat/active-workspace';
import { reloadChannels } from '../chat/data';
import {
  acceptOffer,
  connect,
  createInvite,
  declineOffer,
  federationQuery,
  removeConnection,
  setConnectionEnabled,
  type FederationConnection,
} from './federation';
import { dateLocale } from '../../i18n/time-format';
import { ConnectionPolicyForm, FederationActivity } from './connection-policy';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
    >
      <header className="flex flex-col gap-1">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

const failed = (fallback: string) => (err: unknown) =>
  toast.error((err instanceof ApiError && err.problem.detail) || fallback);

/** Connections to other Cenacle servers and the channels they share. */
export function FederationPage() {
  const { t } = useTranslation();
  const ws = useActiveWorkspace().id;
  const query = useQuery({ ...federationQuery(ws ?? ''), enabled: !!ws });
  if (!ws || query.isPending) return <Skeleton className="h-40" />;
  if (!query.data) {
    return (
      <InlineError
        title={t('federation.loadFailed')}
        problem={query.error instanceof ApiError ? query.error.problem : { status: 500 }}
      />
    );
  }
  return (
    // Two columns on wide screens: the connections beside the ways to add one.
    <div
      className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-sm:px-4"
      data-testid="federation"
    >
      <div className="flex min-w-0 flex-col gap-4">
        {query.data.offers.length > 0 && <Offers ws={ws} offers={query.data.offers} />}
        <Connections ws={ws} connections={query.data.connections} />
        <Section title={t('federation.activity.title')} hint={t('federation.activity.hint')}>
          <FederationActivity ws={ws} />
        </Section>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Invite ws={ws} />
        <Connect ws={ws} />
      </div>
    </div>
  );
}

function Offers({
  ws,
  offers,
}: {
  ws: string;
  offers: { id: string; name: string; topic: string; connection_name: string }[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const reload = () => queryClient.invalidateQueries({ queryKey: federationQuery(ws).queryKey });
  return (
    <Section title={t('federation.offers.title')} hint={t('federation.offers.hint')}>
      <ul className="flex flex-col gap-2">
        {offers.map((o) => (
          <li
            key={o.id}
            data-testid="offer"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">#{o.name}</span>
              <span className="text-muted-foreground">
                {t('federation.offers.from', { server: o.connection_name })}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void declineOffer(o.id)
                  .then(reload)
                  .catch(failed(t('federation.failed')))
              }
            >
              {t('federation.offers.decline')}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void acceptOffer(o.id)
                  .then(async (c) => {
                    await reloadChannels(queryClient);
                    await reload();
                    void navigate({ to: '/c/$channelId', params: { channelId: c.id } });
                  })
                  .catch(failed(t('federation.failed')))
              }
            >
              {t('federation.offers.accept')}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Connections({ ws, connections }: { ws: string; connections: FederationConnection[] }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<FederationConnection | null>(null);
  const reload = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: federationQuery(ws).queryKey }),
      queryClient.invalidateQueries({ queryKey: ['federation-activity', ws] }),
    ]);
  const time = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <Section title={t('federation.connections.title')} hint={t('federation.connections.hint')}>
      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('federation.connections.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <li
              key={c.id}
              data-testid="connection"
              className="flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <GlobeIcon
                  aria-hidden
                  className="size-4 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground">{c.url}</span>
                <span className="text-muted-foreground">{t(`federation.status.${c.status}`)}</span>
                <span className="ms-auto flex gap-2">
                  {c.status !== 'pending' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void setConnectionEnabled(c.id, c.status !== 'active')
                          .then(reload)
                          .catch(failed(t('federation.failed')))
                      }
                    >
                      {c.status === 'active'
                        ? t('federation.connections.pause')
                        : t('federation.connections.resume')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setRemoving(c)}>
                    {t('federation.connections.remove')}
                  </Button>
                </span>
              </div>
              {c.last_seen_at && (
                <p className="text-xs text-muted-foreground">
                  {t('federation.connections.seen', {
                    time: time.format(new Date(c.last_seen_at)),
                  })}
                </p>
              )}
              {c.last_error && (
                <InlineError
                  title={t('federation.connections.error')}
                  reason={c.last_error}
                  politeness="status"
                />
              )}
              {c.status !== 'pending' && (
                <ConnectionPolicyForm connection={c} onSaved={() => void reload()} />
              )}
              {c.shared.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('federation.connections.shared', {
                    channels: c.shared
                      .map(
                        (s) =>
                          `#${s.channel_name}${s.status === 'offered' ? ` (${t('federation.offered')})` : ''}`,
                      )
                      .join(', '),
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        severity="s2"
        title={t('federation.connections.removeTitle', { name: removing?.name ?? '' })}
        description={t('federation.connections.removeHint')}
        confirmLabel={t('federation.connections.remove')}
        onConfirm={async () => {
          if (!removing) return;
          await removeConnection(removing.id);
          await reload();
          setRemoving(null);
        }}
      />
    </Section>
  );
}

function Invite({ ws }: { ws: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Section title={t('federation.invite.title')} hint={t('federation.invite.hint')}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          createInvite(ws, name.trim())
            .then((r) => setCode(r.code))
            .catch(failed(t('federation.failed')))
            .finally(() => setBusy(false));
        }}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('federation.invite.name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            required
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy || !name.trim()} aria-busy={busy}>
          <Link2Icon strokeWidth={1.75} />
          {t('federation.invite.create')}
        </Button>
      </form>
      {code && (
        <div className="flex flex-col gap-2" data-testid="invite-code">
          <Label htmlFor={`${id}-code`}>{t('federation.invite.code')}</Label>
          <div className="flex gap-2">
            <Input id={`${id}-code`} readOnly value={code} onFocus={(e) => e.target.select()} />
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(code)
                  .then(() => toast.success(t('federation.invite.copied')))
                  .catch(() => undefined)
              }
            >
              <CopyIcon strokeWidth={1.75} />
              {t('federation.invite.copy')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('federation.invite.once')}</p>
        </div>
      )}
    </Section>
  );
}

function Connect({ ws }: { ws: string }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Section title={t('federation.connect.title')} hint={t('federation.connect.hint')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          connect(ws, code.trim(), name.trim())
            .then(() => {
              setCode('');
              setName('');
              toast.success(t('federation.connect.done'));
              return queryClient.invalidateQueries({ queryKey: federationQuery(ws).queryKey });
            })
            .catch((err: unknown) => setError(err))
            .finally(() => setBusy(false));
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-code`}>{t('federation.connect.code')}</Label>
          <Input
            id={`${id}-code`}
            value={code}
            required
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('federation.connect.name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            required
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error !== null && (
          <InlineError
            title={t('federation.connect.failed')}
            problem={error instanceof ApiError ? error.problem : { status: 500 }}
            reason={error instanceof ApiError ? error.problem.detail : undefined}
          />
        )}
        <div>
          <Button type="submit" disabled={busy || !code.trim() || !name.trim()} aria-busy={busy}>
            {t('federation.connect.submit')}
          </Button>
        </div>
      </form>
    </Section>
  );
}
