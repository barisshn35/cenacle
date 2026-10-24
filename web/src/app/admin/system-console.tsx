// SPDX-License-Identifier: AGPL-3.0-only
import {
  ActivityIcon,
  BellIcon,
  BotIcon,
  BuildingIcon,
  GaugeIcon,
  GlobeIcon,
  DownloadIcon,
  LogOutIcon,
  UserXIcon,
  ScrollTextIcon,
  ShieldIcon,
  UsersIcon,
} from 'lucide-react';
import { useDeferredValue, useId, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Dialog } from '@cenacle/ui/components/dialog';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { dateLocale } from '../../i18n/time-format';
import { Board, BoardGroup } from '../shell/board';
import { boardCell, boardRow } from '../shell/board-styles';
import { SideNavDialog } from '../shell/side-nav-dialog';
import { formatSize } from '../chat/files';
import { AuditPanel } from './audit-panel';
import { useSystemConsole } from './console-state';

type Overview = components['schemas']['AdminOverview'];
type AdminUser = components['schemas']['AdminUser'];
type AdminWorkspace = components['schemas']['AdminWorkspace'];
type AdminBot = components['schemas']['AdminBot'];
type Policy = components['schemas']['NotificationPolicy'];
type SessionPolicy = components['schemas']['SessionPolicy'];
type FederationPolicy = components['schemas']['FederationPolicy'];
type Section =
  | 'overview'
  | 'people'
  | 'workspaces'
  | 'bots'
  | 'jobs'
  | 'notifications'
  | 'security'
  | 'federation'
  | 'audit';

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const overviewQuery = {
  queryKey: ['admin', 'overview'],
  queryFn: () => apiFetch<Overview>('/api/admin/overview'),
};

/**
 * The system console (v0.34): the whole installation for its administrators —
 * counts and settings, everyone, every workspace and bot, background jobs and
 * what notifications may show.
 */
export function SystemConsole({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>('overview');
  const overview = useQuery(overviewQuery);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <SideNavDialog
        id="system-console"
        title={t('console.title')}
        subtitle={overview.data ? t('console.version', { version: overview.data.version }) : ''}
        value={section}
        onChange={setSection}
        description={t(`console.sections.${section}`)}
        groups={[
          {
            items: [
              { key: 'overview', label: t('console.names.overview'), icon: GaugeIcon },
              {
                key: 'people',
                label: t('console.names.people'),
                icon: UsersIcon,
                count: overview.data ? Number(overview.data.counts.users) : undefined,
              },
              {
                key: 'workspaces',
                label: t('console.names.workspaces'),
                icon: BuildingIcon,
                count: overview.data ? Number(overview.data.counts.workspaces) : undefined,
              },
              { key: 'bots', label: t('console.names.bots'), icon: BotIcon },
              { key: 'jobs', label: t('console.names.jobs'), icon: ActivityIcon },
              { key: 'notifications', label: t('console.names.notifications'), icon: BellIcon },
              { key: 'security', label: t('console.names.security'), icon: ShieldIcon },
              { key: 'federation', label: t('console.names.federation'), icon: GlobeIcon },
              { key: 'audit', label: t('console.names.audit'), icon: ScrollTextIcon },
            ],
          },
        ]}
      >
        <div className="pt-4">
          {section === 'overview' && <OverviewPanel overview={overview.data} />}
          {section === 'people' && <PeoplePanel />}
          {section === 'workspaces' && <WorkspacesPanel />}
          {section === 'bots' && <BotsPanel />}
          {section === 'jobs' && <JobsPanel overview={overview.data} />}
          {section === 'notifications' && <NotificationsPanel />}
          {section === 'security' && <SecurityPanel />}
          {section === 'federation' && <FederationPolicyPanel />}
          {section === 'audit' && <AuditPanel />}
        </div>
      </SideNavDialog>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[10px] border px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function OverviewPanel({ overview }: { overview?: Overview }) {
  const { t, i18n } = useTranslation();
  if (!overview) return <Skeleton className="h-40" />;
  const n = new Intl.NumberFormat(dateLocale(i18n.language));
  const c = overview.counts;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('console.counts.users')} value={n.format(Number(c.users))} />
        <Stat label={t('console.counts.active')} value={n.format(Number(c.active_users))} />
        <Stat label={t('console.counts.workspaces')} value={n.format(Number(c.workspaces))} />
        <Stat label={t('console.counts.channels')} value={n.format(Number(c.channels))} />
        <Stat label={t('console.counts.messages')} value={n.format(Number(c.messages))} />
        <Stat label={t('console.counts.files')} value={n.format(Number(c.files))} />
        <Stat
          label={t('console.counts.storage')}
          value={formatSize(Number(c.file_bytes), i18n.language)}
        />
        <Stat label={t('console.counts.bots')} value={n.format(Number(c.bots))} />
      </div>
      <section aria-labelledby="console-config" className="flex flex-col gap-2">
        <h3 id="console-config" className="text-sm font-semibold">
          {t('console.config')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('console.configHint')}</p>
        {overview.config.length > 0 && (
          <dl className="divide-y rounded-[10px] border text-sm">
            {overview.config.map((s) => (
              <div
                key={s.name}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 px-3 py-1.5"
              >
                <dt className="truncate font-mono text-xs text-muted-foreground">{s.name}</dt>
                <dd className="truncate font-mono text-xs" title={s.value}>
                  {s.value || '—'}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}

function PeoplePanel() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const [ending, setEnding] = useState<AdminUser | null>(null);
  const [erasing, setErasing] = useState<AdminUser | null>(null);
  const queryClient = useQueryClient();
  const people = useInfiniteQuery({
    queryKey: ['admin', 'users', query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (pageParam) {
        params.set('after_name', pageParam.after_name);
        params.set('after_id', pageParam.after_id);
      }
      return apiFetch<{ users: AdminUser[]; next?: { after_name: string; after_id: string } }>(
        `/api/admin/users?${params}`,
      );
    },
    initialPageParam: undefined as { after_name: string; after_id: string } | undefined,
    getNextPageParam: (last) => last.next,
  });
  const rows = people.data?.pages.flatMap((p) => p.users) ?? [];
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid max-w-sm gap-1.5">
        <Label htmlFor={id}>{t('console.findPeople')}</Label>
        <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Board
        label={t('console.names.people')}
        minWidth="min-w-[48rem]"
        columns={[
          { label: t('console.columns.person') },
          { label: t('console.columns.role'), width: 'w-[120px]' },
          { label: t('console.columns.lastSeen'), width: 'w-[130px]' },
          { label: t('console.columns.workspaces'), width: 'w-[100px]', align: 'end' },
          { label: t('console.columns.sessions'), width: 'w-[150px]', align: 'end' },
          { label: t('console.columns.data'), width: 'w-[110px]', align: 'end' },
        ]}
      >
        <BoardGroup span={6}>
          {rows.map((u) => (
            <tr key={u.id} className={boardRow()} data-testid="console-person">
              <td className={boardCell}>
                <p className="truncate text-sm font-medium">{u.display_name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {u.email}
                  {u.username && ` · @${u.username}`}
                </p>
              </td>
              <td className={`${boardCell} text-xs`}>
                {u.deactivated
                  ? t('console.role.deactivated')
                  : u.is_admin
                    ? t('console.role.admin')
                    : u.guest
                      ? t('console.role.guest')
                      : t('console.role.member')}
              </td>
              <td className={`${boardCell} font-mono text-xs`}>
                {u.last_seen_at ? when.format(new Date(u.last_seen_at)) : '—'}
              </td>
              <td className={`${boardCell} text-right font-mono text-xs`}>{u.workspaces}</td>
              <td className={`${boardCell} text-right`}>
                <span className="mr-2 font-mono text-xs">{u.sessions}</span>
                {u.sessions > 0 && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('console.signOut', { name: u.display_name })}
                    onClick={() => setEnding(u)}
                  >
                    <LogOutIcon strokeWidth={1.75} />
                  </Button>
                )}
              </td>
              <td className={`${boardCell} text-right`}>
                <a
                  href={`/api/admin/users/${u.id}/export`}
                  download="cenacle-data.ndjson"
                  aria-label={t('console.exportData', { name: u.display_name })}
                  className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
                >
                  <DownloadIcon aria-hidden className="size-4" strokeWidth={1.75} />
                </a>
                {!u.erased && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('console.erase', { name: u.display_name })}
                    onClick={() => setErasing(u)}
                  >
                    <UserXIcon strokeWidth={1.75} />
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </BoardGroup>
      </Board>
      {people.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={people.isFetchingNextPage}
          onClick={() => void people.fetchNextPage()}
        >
          {t('console.more')}
        </Button>
      )}
      <ConfirmDialog
        open={!!ending}
        onOpenChange={(o) => !o && setEnding(null)}
        severity="s2"
        title={t('console.signOutTitle', { name: ending?.display_name ?? '' })}
        description={<p>{t('console.signOutDescription')}</p>}
        confirmLabel={t('console.signOutConfirm')}
        onConfirm={async () => {
          await apiFetch<void>(`/api/admin/users/${ending!.id}/sessions`, { method: 'DELETE' });
          await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
          toast.success(t('console.signedOut', { name: ending!.display_name }));
        }}
      />
      <ConfirmDialog
        open={!!erasing}
        onOpenChange={(o) => !o && setErasing(null)}
        severity="s3"
        irreversible
        title={t('console.eraseTitle', { name: erasing?.display_name ?? '' })}
        description={<p>{t('console.eraseDescription')}</p>}
        confirmationText={erasing?.display_name}
        confirmLabel={t('console.eraseConfirm')}
        onConfirm={async () => {
          const r = await apiFetch<{ messages_erased: number; messages_held: number }>(
            `/api/admin/users/${erasing!.id}/erase`,
            json('POST', { confirm: erasing!.display_name }),
          );
          await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
          toast.success(t('console.erased', { erased: r.messages_erased, held: r.messages_held }));
        }}
      />
    </div>
  );
}

function WorkspacesPanel() {
  const { t, i18n } = useTranslation();
  const list = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: () =>
      apiFetch<{ workspaces: AdminWorkspace[] }>('/api/admin/workspaces').then((r) => r.workspaces),
  });
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  return (
    <Board
      label={t('console.names.workspaces')}
      minWidth="min-w-[40rem]"
      columns={[
        { label: t('console.columns.workspace') },
        { label: t('console.columns.members'), width: 'w-[110px]', align: 'end' },
        { label: t('console.columns.channels'), width: 'w-[110px]', align: 'end' },
        { label: t('console.columns.created'), width: 'w-[140px]' },
      ]}
    >
      <BoardGroup span={4}>
        {(list.data ?? []).map((w) => (
          <tr key={w.id} className={boardRow()}>
            <td className={boardCell}>
              <span className="text-sm font-medium">{w.name}</span>
              {w.is_default && (
                <span className="ml-2 text-xs text-muted-foreground">{t('console.default')}</span>
              )}
            </td>
            <td className={`${boardCell} text-right font-mono text-xs`}>{w.members}</td>
            <td className={`${boardCell} text-right font-mono text-xs`}>{w.channels}</td>
            <td className={`${boardCell} font-mono text-xs`}>
              {when.format(new Date(w.created_at))}
            </td>
          </tr>
        ))}
      </BoardGroup>
    </Board>
  );
}

function BotsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'bots'],
    queryFn: () => apiFetch<{ bots: AdminBot[] }>('/api/admin/bots').then((r) => r.bots),
  });
  const toggle = useMutation({
    mutationFn: (b: AdminBot) =>
      apiFetch<void>(`/api/admin/bots/${b.id}`, json('PATCH', { disabled: !b.disabled })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'bots'] }),
    onError: () => toast.error(t('console.changeFailed')),
  });
  if (list.data?.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('console.noBots')}</p>;
  }
  return (
    <Board
      label={t('console.names.bots')}
      minWidth="min-w-[40rem]"
      columns={[
        { label: t('console.columns.bot') },
        { label: t('console.columns.workspace'), width: 'w-[180px]' },
        { label: t('console.columns.state'), width: 'w-[200px]', align: 'end' },
      ]}
    >
      <BoardGroup span={3}>
        {(list.data ?? []).map((b) => (
          <tr key={b.id} className={boardRow(b.disabled)}>
            <td className={boardCell}>
              <span className="text-sm font-medium">{b.name}</span>
              {b.interactions && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t('console.interactive')}
                </span>
              )}
            </td>
            <td className={`${boardCell} truncate text-sm`}>{b.workspace_name}</td>
            <td className={`${boardCell} text-right`}>
              <Button
                size="sm"
                variant="outline"
                aria-label={
                  b.disabled
                    ? t('console.enableBot', { name: b.name })
                    : t('console.disableBot', { name: b.name })
                }
                onClick={() => toggle.mutate(b)}
              >
                {b.disabled ? t('glossary.enable') : t('glossary.disable')}
              </Button>
            </td>
          </tr>
        ))}
      </BoardGroup>
    </Board>
  );
}

function JobsPanel({ overview }: { overview?: Overview }) {
  const { t, i18n } = useTranslation();
  if (!overview) return <Skeleton className="h-40" />;
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return (
    <div className="flex flex-col gap-6">
      {overview.jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('console.noJobs')}</p>
      ) : (
        <Board
          label={t('console.names.jobs')}
          minWidth="min-w-[44rem]"
          columns={[
            { label: t('console.columns.job') },
            { label: t('console.columns.waiting'), width: 'w-[90px]', align: 'end' },
            { label: t('console.columns.running'), width: 'w-[90px]', align: 'end' },
            { label: t('console.columns.retrying'), width: 'w-[90px]', align: 'end' },
            { label: t('console.columns.failed'), width: 'w-[90px]', align: 'end' },
            { label: t('console.columns.done'), width: 'w-[100px]', align: 'end' },
          ]}
        >
          <BoardGroup span={6}>
            {overview.jobs.map((j) => (
              <tr key={j.kind} className={boardRow(j.discarded > 0 || j.retryable > 0)}>
                <td className={`${boardCell} font-mono text-xs`}>{j.kind}</td>
                {[j.available, j.running, j.retryable, j.discarded, j.completed].map((v, i) => (
                  <td key={i} className={`${boardCell} text-right font-mono text-xs`}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </BoardGroup>
        </Board>
      )}
      <section aria-labelledby="console-failures" className="flex flex-col gap-2">
        <h3 id="console-failures" className="text-sm font-semibold">
          {t('console.failures')}
        </h3>
        {overview.failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('console.noFailures')}</p>
        ) : (
          <ul className="divide-y rounded-[10px] border text-sm">
            {overview.failures.map((f, i) => (
              <li key={i} className="flex flex-col gap-0.5 px-3 py-2">
                <span className="font-mono text-xs">
                  {f.kind} · {f.state} · {t('console.attempt', { n: f.attempt })} ·{' '}
                  {when.format(new Date(f.at))}
                </span>
                <span className="text-xs break-words text-muted-foreground">{f.error}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NotificationsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Shown as chosen at once; a failed change goes back to the saved policy.
  const [chosen, setChosen] = useState<Policy | null>(null);
  const policy = useQuery({
    queryKey: ['admin', 'notification-policy'],
    queryFn: () => apiFetch<Policy>('/api/admin/notification-policy'),
  });
  const set = useMutation({
    mutationFn: (p: Policy) => apiFetch<Policy>('/api/admin/notification-policy', json('PUT', p)),
    onSuccess: (p) => {
      queryClient.setQueryData(['admin', 'notification-policy'], p);
      void queryClient.invalidateQueries({ queryKey: ['meta'] });
    },
    onError: () => {
      setChosen(null);
      toast.error(t('console.changeFailed'));
    },
  });
  if (!policy.data) return <Skeleton className="h-40" />;
  const value = chosen ?? policy.data;
  const choose = (next: Policy) => {
    setChosen(next);
    set.mutate(next);
  };
  const group = <K extends keyof Policy>(key: K, options: Policy[K][]) => (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">{t(`console.policy.${key}`)}</legend>
      {options.map((o) => (
        <div key={String(o)} className="flex min-h-target items-start gap-2.5 text-sm">
          <input
            id={`${key}-${o}`}
            type="radio"
            name={key}
            className="mt-1 size-4"
            checked={value?.[key] === o}
            aria-describedby={`${key}-${o}-hint`}
            onChange={() => choose({ ...value, [key]: o })}
          />
          <div>
            <label htmlFor={`${key}-${o}`} className="font-medium">
              {t(`console.policy.${key}_${o}`)}
            </label>
            <p id={`${key}-${o}-hint`} className="text-xs text-muted-foreground">
              {t(`console.policy.${key}_${o}_hint`)}
            </p>
          </div>
        </div>
      ))}
    </fieldset>
  );
  return (
    <div className="flex max-w-xl flex-col gap-6">
      {group('push_contents', ['full', 'sender', 'none'])}
      {group('email_contents', ['full', 'sender'])}
    </div>
  );
}

const LIMITS = [
  ['session_max_hours', 'hours'],
  ['session_idle_minutes', 'minutes'],
  ['guest_session_max_hours', 'hours'],
  ['guest_idle_minutes', 'minutes'],
] as const;

/** How long sessions last and which networks may sign in and administer. */
function SecurityPanel() {
  const queryClient = useQueryClient();
  const policy = useQuery({
    queryKey: ['admin', 'session-policy'],
    queryFn: () => apiFetch<SessionPolicy>('/api/admin/session-policy'),
  });
  if (!policy.data) return <Skeleton className="h-60" />;
  return (
    <SecurityForm
      policy={policy.data}
      onSaved={(p) => queryClient.setQueryData(['admin', 'session-policy'], p)}
    />
  );
}

function SecurityForm({
  policy,
  onSaved,
}: {
  policy: SessionPolicy;
  onSaved: (p: SessionPolicy) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [limits, setLimits] = useState(() =>
    Object.fromEntries(LIMITS.map(([k]) => [k, String(policy[k])])),
  );
  const [adminNets, setAdminNets] = useState(policy.admin_networks.join('\n'));
  const [signinNets, setSigninNets] = useState(policy.signin_networks.join('\n'));
  const lines = (v: string) =>
    v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const save = useMutation({
    mutationFn: () =>
      apiFetch<SessionPolicy>(
        '/api/admin/session-policy',
        json('PUT', {
          ...Object.fromEntries(LIMITS.map(([k]) => [k, Number(limits[k]) || 0])),
          admin_networks: lines(adminNets),
          signin_networks: lines(signinNets),
        }),
      ),
    onSuccess: (p) => {
      onSaved(p);
      toast.success(t('console.security.saved'));
    },
  });
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;
  const operator = [
    policy.operator_max_hours
      ? t('console.security.operatorHours', { count: policy.operator_max_hours })
      : '',
    policy.operator_idle_minutes
      ? t('console.security.operatorMinutes', { count: policy.operator_idle_minutes })
      : '',
  ].filter(Boolean);
  return (
    <form
      className="flex max-w-xl flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">{t('console.security.sessions')}</legend>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {t('console.security.sessionsHint')}
          {operator.length > 0 &&
            ` ${t('console.security.operator', { limits: operator.join(', ') })}`}
        </p>
        {LIMITS.map(([key, unit]) => (
          <div key={key} className="grid gap-1">
            <Label htmlFor={`${id}-${key}`}>{t(`console.security.${key}`)}</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`${id}-${key}`}
                type="number"
                inputMode="numeric"
                min={0}
                className="w-28"
                value={limits[key]}
                onChange={(e) => setLimits((l) => ({ ...l, [key]: e.target.value }))}
              />
              <span className="text-xs text-muted-foreground">{t(`console.security.${unit}`)}</span>
            </div>
          </div>
        ))}
      </fieldset>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-admin`}>{t('console.security.adminNetworks')}</Label>
        <textarea
          id={`${id}-admin`}
          className="min-h-20 rounded-md border bg-background px-3 py-2 font-mono text-sm"
          value={adminNets}
          spellCheck={false}
          aria-describedby={`${id}-admin-hint`}
          onChange={(e) => setAdminNets(e.target.value)}
        />
        <p id={`${id}-admin-hint`} className="text-xs text-muted-foreground">
          {t('console.security.networksHint', { address: policy.your_address ?? '' })}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-signin`}>{t('console.security.signinNetworks')}</Label>
        <textarea
          id={`${id}-signin`}
          className="min-h-20 rounded-md border bg-background px-3 py-2 font-mono text-sm"
          value={signinNets}
          spellCheck={false}
          onChange={(e) => setSigninNets(e.target.value)}
        />
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem.detail ?? t('console.changeFailed')}
        </p>
      )}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('console.security.save')}
        </Button>
      </div>
    </form>
  );
}

/** Which servers the workspaces may connect to. */
function FederationPolicyPanel() {
  const queryClient = useQueryClient();
  const policy = useQuery({
    queryKey: ['admin', 'federation-policy'],
    queryFn: () => apiFetch<FederationPolicy>('/api/admin/federation-policy'),
  });
  if (!policy.data) return <Skeleton className="h-40" />;
  return (
    <FederationPolicyForm
      policy={policy.data}
      onSaved={(p) => queryClient.setQueryData(['admin', 'federation-policy'], p)}
    />
  );
}

function FederationPolicyForm({
  policy,
  onSaved,
}: {
  policy: FederationPolicy;
  onSaved: (p: FederationPolicy) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [mode, setMode] = useState(policy.mode);
  const [servers, setServers] = useState(policy.servers.join('\n'));
  const save = useMutation({
    mutationFn: () =>
      apiFetch<FederationPolicy>(
        '/api/admin/federation-policy',
        json('PUT', {
          mode,
          servers: servers
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      ),
    onSuccess: (p) => {
      onSaved(p);
      toast.success(t('console.federation.saved'));
    },
  });
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;
  return (
    <form
      className="flex max-w-xl flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">{t('console.federation.mode')}</legend>
        {(['open', 'allow', 'deny'] as const).map((m) => (
          <label key={m} className="flex min-h-target items-center gap-2.5 text-sm">
            <input
              type="radio"
              name={`${id}-mode`}
              className="size-4"
              data-target-exempt
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            {t(`console.federation.${m}`)}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-servers`}>{t('console.federation.servers')}</Label>
        <textarea
          id={`${id}-servers`}
          className="min-h-24 rounded-md border bg-background px-3 py-2 font-mono text-sm"
          value={servers}
          spellCheck={false}
          disabled={mode === 'open'}
          aria-describedby={`${id}-servers-hint`}
          onChange={(e) => setServers(e.target.value)}
        />
        <p id={`${id}-servers-hint`} className="text-xs text-muted-foreground">
          {t('console.federation.serversHint')}
        </p>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem.detail ?? t('console.changeFailed')}
        </p>
      )}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('console.federation.save')}
        </Button>
      </div>
    </form>
  );
}

/** Shows the system console while it is open. */
export function SystemConsoleHost() {
  const open = useSystemConsole((s) => s.open);
  const setOpen = useSystemConsole((s) => s.setOpen);
  return open ? <SystemConsole onOpenChange={setOpen} /> : null;
}
