// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArchiveIcon, CheckIcon, SearchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { cn } from '@cenacle/ui/lib/utils';
import { ChannelIcon } from './channel-icon';
import { useActiveWorkspace } from './active-workspace';
import { directoryQuery, joinChannel, reloadChannels, type Channel } from './data';

/** Every channel, to open or join. */
export function ChannelDirectory({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { id: workspaceId } = useActiveWorkspace();
  const directory = useQuery({ ...directoryQuery(workspaceId), enabled: open && !!workspaceId });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const go = (c: Channel) => {
    onOpenChange(false);
    void navigate({ to: '/c/$channelId', params: { channelId: c.id } });
  };
  const join = useMutation({
    mutationFn: (c: Channel) => joinChannel(c.id),
    onSuccess: (c) => {
      void reloadChannels(queryClient);
      go(c);
    },
  });

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'joined' | 'other'>('all');
  const [archived, setArchived] = useState(false);
  const all = (directory.data ?? []).filter((c) => archived || !c.archived);
  const needle = query.trim().toLocaleLowerCase();
  const matching = needle
    ? all.filter(
        (c) =>
          c.name.toLocaleLowerCase().includes(needle) ||
          c.topic.toLocaleLowerCase().includes(needle),
      )
    : all;
  const counts = {
    all: matching.length,
    joined: matching.filter((c) => c.is_member).length,
    other: matching.filter((c) => !c.is_member).length,
  };
  const shown = matching.filter((c) =>
    filter === 'all' ? true : filter === 'joined' ? c.is_member : !c.is_member,
  );
  const kind = (c: Channel) =>
    c.visibility === 'private'
      ? t('channels.kinds.private')
      : t(`channels.kinds.${c.kind}`, { defaultValue: t('channels.kinds.standard') });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('channels.browseTitle')}</DialogTitle>
          <DialogDescription>{t('channels.browseDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-56">
            <span className="sr-only">{t('channels.searchDirectory')}</span>
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.75}
            />
            <Input
              type="search"
              value={query}
              placeholder={t('channels.searchDirectory')}
              className="pl-9"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div
            role="radiogroup"
            aria-label={t('channels.directoryFilter')}
            className="inline-flex rounded-[8px] border border-rule-strong p-0.5"
          >
            {(['all', 'joined', 'other'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={filter === k}
                onClick={() => setFilter(k)}
                className={cn(
                  'flex h-7 min-h-target items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  filter === k
                    ? 'bg-accent font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`channels.directoryFilters.${k}`)}
                <span className="font-mono text-xs font-normal">{counts[k]}</span>
              </button>
            ))}
          </div>
          <label className="flex min-h-target items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="size-target shrink-0 accent-primary"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            {t('channels.showArchived')}
          </label>
        </div>
        {directory.isPending ? (
          <div aria-hidden className="grid gap-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : directory.isError ? (
          <ErrorState
            problem={
              directory.error instanceof ApiError ? directory.error.problem : { status: 500 }
            }
          />
        ) : (
          <div className="flex min-h-0 flex-col gap-2">
            <p role="status" className="text-xs text-muted-foreground">
              {needle
                ? t('channels.directoryMatches', { count: shown.length, query: query.trim() })
                : t('channels.directoryCount', { count: shown.length })}
            </p>
            {shown.length > 0 && (
              <ul className="min-h-0 overflow-y-auto rounded-[10px] border border-rule-strong bg-background">
                {shown.map((c) => (
                  <li
                    key={c.id}
                    data-testid="directory-channel"
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t px-3 py-2.5 first:border-t-0 sm:grid-cols-[220px_minmax(0,1fr)_88px_120px_auto]"
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <ChannelIcon
                        channel={c}
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{c.name}</p>
                        <p className="text-xs text-muted-foreground">{kind(c)}</p>
                      </div>
                    </div>
                    <p className="col-span-2 line-clamp-2 text-[13px] text-muted-foreground max-sm:order-last sm:col-span-1">
                      {c.topic || '—'}
                    </p>
                    <span className="text-right font-mono text-[13px] text-muted-foreground max-sm:hidden">
                      {c.member_count !== undefined ? (
                        <>
                          <span aria-hidden>{c.member_count}</span>
                          <span className="sr-only">
                            {t('channels.memberCount', { count: c.member_count })}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 text-[13px] max-sm:hidden">
                      {c.archived ? (
                        <>
                          <ArchiveIcon
                            aria-hidden
                            className="size-4 text-muted-foreground"
                            strokeWidth={1.75}
                          />
                          {t('channels.dirArchived')}
                        </>
                      ) : c.is_member ? (
                        <>
                          <CheckIcon aria-hidden className="size-4" strokeWidth={1.75} />
                          {t('channels.dirMember')}
                        </>
                      ) : (
                        <span className="text-muted-foreground">{t('channels.notJoined')}</span>
                      )}
                    </span>
                    <span className="justify-self-end">
                      {c.is_member || c.archived ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('channels.openChannelNamed', { channel: c.name })}
                          onClick={() => go(c)}
                        >
                          {t('channels.open')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={join.isPending}
                          onClick={() => join.mutate(c)}
                          aria-label={t('channels.joinNamed', { channel: c.name })}
                        >
                          {t('channels.join')}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t('channels.directoryNote')}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
