// SPDX-License-Identifier: AGPL-3.0-only
import { DownloadIcon } from 'lucide-react';
import { useDeferredValue, useId, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { dateLocale } from '../../i18n/time-format';

type AuditEvent = components['schemas']['AuditEvent'];
type AuditStream = components['schemas']['AuditStream'];

const PREFIXES = [
  '',
  'instance.',
  'admin.',
  'workspace.',
  'channel.',
  'federation.',
  'guest_link.',
];

/** The installation's audit log: filter, read, download, and stream it to a SIEM. */
export function AuditPanel() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [prefix, setPrefix] = useState('');
  const [typed, setTyped] = useState('');
  const custom = useDeferredValue(typed.trim());
  const action = custom || prefix;
  const events = useInfiniteQuery({
    queryKey: ['admin', 'audit', action],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (action) params.set('prefix', action);
      if (pageParam) params.set('before', pageParam);
      return apiFetch<{ events: AuditEvent[]; has_more: boolean }>(`/api/admin/audit?${params}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => (last.has_more ? last.events.at(-1)?.id : undefined),
  });
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  const exportURL = `/api/admin/audit/export${action ? `?prefix=${encodeURIComponent(action)}` : ''}`;
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby={`${id}-log`} className="flex flex-col gap-3">
        <h3 id={`${id}-log`} className="text-sm font-semibold">
          {t('console.audit.log')}
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-kind`}>{t('console.audit.kind')}</Label>
            <select
              id={`${id}-kind`}
              className="min-h-target h-9 rounded-md border bg-background px-2 text-sm"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            >
              {PREFIXES.map((p) => (
                <option key={p} value={p}>
                  {t(`console.audit.kinds.${p.replace('.', '') || 'all'}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-action`}>{t('console.audit.action')}</Label>
            <Input
              id={`${id}-action`}
              className="w-56 font-mono"
              placeholder="session.ended"
              value={typed}
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <a
            href={exportURL}
            download="cenacle-audit.ndjson"
            className="inline-flex min-h-target items-center gap-2 rounded-lg border px-3 text-sm font-medium hover:bg-muted"
          >
            <DownloadIcon aria-hidden className="size-4" strokeWidth={1.75} />
            {t('console.audit.download')}
          </a>
        </div>
        {events.isPending ? (
          <Skeleton className="h-40" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('console.audit.none')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm" data-testid="audit-events">
              <thead>
                <tr className="border-b bg-muted/40 text-start text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('console.audit.when')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('console.audit.action')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('console.audit.who')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('console.audit.where')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b last:border-b-0 align-top">
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground">
                      {when.format(new Date(e.at))}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{e.action}</td>
                    <td className="px-3 py-1.5">
                      {e.actor?.display_name ?? t('console.audit.system')}
                      {e.ip_address && (
                        <span className="block text-xs text-muted-foreground">{e.ip_address}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {e.workspace?.name ?? t('console.audit.installation')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.hasNextPage && (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={events.isFetchingNextPage}
              onClick={() => void events.fetchNextPage()}
            >
              {t('console.audit.more')}
            </Button>
          </div>
        )}
      </section>
      <StreamSection />
    </div>
  );
}

function StreamSection() {
  const queryClient = useQueryClient();
  const stream = useQuery({
    queryKey: ['admin', 'audit-stream'],
    queryFn: () => apiFetch<AuditStream>('/api/admin/audit-stream'),
  });
  if (!stream.data) return <Skeleton className="h-32" />;
  return (
    <StreamForm
      stream={stream.data}
      onSaved={(s) => queryClient.setQueryData(['admin', 'audit-stream'], s)}
    />
  );
}

function StreamForm({
  stream,
  onSaved,
}: {
  stream: AuditStream;
  onSaved: (s: AuditStream) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [kind, setKind] = useState(stream.kind);
  const [address, setAddress] = useState(stream.address);
  const [tls, setTls] = useState(stream.tls);
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: () =>
      apiFetch<AuditStream>('/api/admin/audit-stream', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, address, tls, ...(secret ? { secret } : {}) }),
      }),
    onSuccess: (s) => {
      setSecret('');
      onSaved(s);
      toast.success(t('console.audit.streamSaved'));
    },
  });
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;
  const sent = stream.last_sent_at
    ? new Intl.DateTimeFormat(dateLocale(i18n.language), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(stream.last_sent_at))
    : '';
  return (
    <form
      aria-labelledby={`${id}-title`}
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-1">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {t('console.audit.stream')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('console.audit.streamHint')}</p>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">{t('console.audit.stream')}</legend>
        {(['none', 'http', 'syslog'] as const).map((k) => (
          <label key={k} className="flex min-h-target items-center gap-2.5 text-sm">
            <input
              type="radio"
              name={`${id}-kind`}
              className="size-4"
              data-target-exempt
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {t(`console.audit.streams.${k}`)}
          </label>
        ))}
      </fieldset>
      {kind !== 'none' && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-address`}>
              {kind === 'http' ? t('console.audit.url') : t('console.audit.hostPort')}
            </Label>
            <Input
              id={`${id}-address`}
              className="font-mono"
              value={address}
              spellCheck={false}
              placeholder={
                kind === 'http' ? 'https://siem.example.com/ingest' : 'siem.example.com:6514'
              }
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          {kind === 'http' ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-secret`}>{t('console.audit.secret')}</Label>
              <Input
                id={`${id}-secret`}
                type="password"
                autoComplete="off"
                value={secret}
                aria-describedby={`${id}-secret-hint`}
                onChange={(e) => setSecret(e.target.value)}
              />
              <p id={`${id}-secret-hint`} className="text-xs text-muted-foreground">
                {stream.has_secret ? t('console.audit.secretKept') : t('console.audit.secretHint')}
              </p>
            </div>
          ) : (
            <label className="flex min-h-target items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                className="size-4"
                data-target-exempt
                checked={tls}
                onChange={(e) => setTls(e.target.checked)}
              />
              {t('console.audit.tls')}
            </label>
          )}
        </>
      )}
      {stream.kind !== 'none' && (
        <p className="text-xs text-muted-foreground" data-testid="stream-state">
          {stream.last_error
            ? t('console.audit.streamError', { error: stream.last_error })
            : sent
              ? t('console.audit.streamSent', { time: sent })
              : t('console.audit.streamWaiting')}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem.detail ?? t('console.changeFailed')}
        </p>
      )}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('console.audit.save')}
        </Button>
      </div>
    </form>
  );
}
