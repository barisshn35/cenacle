// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { DownloadIcon, SearchIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ErrorState } from '@cenacle/ui/components/error-state';
import type { ProblemLike } from '@cenacle/ui/lib/errors';
import { ApiError } from '@cenacle/core/api';
import { useSidebar } from '@cenacle/ui/components/sidebar';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';
import { useActiveWorkspace } from '../chat/active-workspace';
import { channelsQuery, peopleQuery, type Person } from '../chat/data';
import { fileUrl, formatSize } from '../chat/files';
import { useJump } from '../chat/jump';
import { FileTypeIcon } from '../chat/message-files';
import {
  excerptParts,
  markTerms,
  plainText,
  searchContentQuery,
  searchFilesQuery,
  searchMessagesQuery,
  searchTerms,
  type MessageFilters,
  type SearchFile,
  type SearchMessage,
} from './search';
import { dateLocale } from '../../i18n/time-format';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

type Tab = 'messages' | 'files' | 'content';

/** Words found in a result, marked. */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {markTerms(text, terms).map((p, i) =>
        p.mark ? (
          <mark
            key={i}
            className="rounded-sm bg-accent px-0.5 font-semibold text-accent-foreground"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Waits for typing to stop before searching. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The right panel's search: messages and files of the person's channels. */
export function SearchPanel() {
  const { t } = useTranslation();
  const ids = { q: useId(), scope: useId(), has: useId(), after: useId(), until: useId() };
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const { id: channelId, channel } = useActiveChannel();
  const { id: workspaceId } = useActiveWorkspace();
  const [text, setText] = useState('');
  const q = useSettled(text.trim());
  const [tab, setTab] = useState<Tab>('messages');
  const [scope, setScope] = useState<'workspace' | 'channel' | 'all'>('workspace');
  const [has, setHas] = useState<'' | 'file' | 'link'>('');
  const [after, setAfter] = useState('');
  const [until, setUntil] = useState('');
  const [from, setFrom] = useState<Person | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const filters: MessageFilters = {
    workspaceId: scope === 'all' ? undefined : workspaceId,
    channelId: scope === 'channel' ? channelId : undefined,
    from: from?.id,
    after: after || undefined,
    until: until || undefined,
    has: has || undefined,
  };

  return (
    <aside
      aria-labelledby="search-title"
      className="flex h-full flex-col overflow-y-auto border-s bg-background"
      data-testid="search-panel"
    >
      <header className="flex min-h-12 items-center justify-between border-b px-3">
        <h2 id="search-title" className="text-sm font-semibold">
          {t('search.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('search.close')}
          onClick={() => setDetailsOpen(false)}
        >
          <XIcon strokeWidth={1.75} />
        </Button>
      </header>
      <div className="flex flex-col gap-3 p-3">
        <div>
          <Label htmlFor={ids.q} className="sr-only">
            {t('search.label')}
          </Label>
          <div className="relative">
            <SearchIcon
              aria-hidden
              strokeWidth={1.75}
              className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={input}
              id={ids.q}
              type="search"
              value={text}
              maxLength={200}
              placeholder={t('search.placeholder')}
              aria-describedby={`${ids.q}-hint`}
              className="ps-8"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <p id={`${ids.q}-hint`} className="mt-1 text-xs text-muted-foreground">
            {t('search.hint')}
          </p>
        </div>
        <div role="tablist" aria-label={t('search.kind')} className="flex gap-1">
          {(['messages', 'files', 'content'] as const).map((k) => (
            <Button
              key={k}
              role="tab"
              size="sm"
              variant={tab === k ? 'secondary' : 'ghost'}
              aria-selected={tab === k}
              aria-controls={`${ids.q}-${k}`}
              onClick={() => setTab(k)}
            >
              {t(`search.tabs.${k}`)}
            </Button>
          ))}
        </div>
        {tab === 'messages' && (
          <details className="group rounded-lg border px-3 py-2 text-sm">
            <summary className="flex min-h-target cursor-pointer items-center font-medium">
              {t('search.filters')}
            </summary>
            <div className="mt-2 grid gap-3">
              <div className="grid gap-1">
                <Label htmlFor={ids.scope}>{t('search.scope')}</Label>
                <select
                  id={ids.scope}
                  className={selectClass}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as typeof scope)}
                >
                  <option value="workspace">{t('search.scopes.workspace')}</option>
                  {channel && (
                    <option value="channel">
                      {t('search.scopes.channel', { channel: channel.name })}
                    </option>
                  )}
                  <option value="all">{t('search.scopes.all')}</option>
                </select>
              </div>
              {workspaceId && (
                <FromFilter workspaceId={workspaceId} value={from} onChange={setFrom} />
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <Label htmlFor={ids.after}>{t('search.after')}</Label>
                  <Input
                    id={ids.after}
                    type="date"
                    value={after}
                    max={until || undefined}
                    onChange={(e) => setAfter(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={ids.until}>{t('search.until')}</Label>
                  <Input
                    id={ids.until}
                    type="date"
                    value={until}
                    min={after || undefined}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={ids.has}>{t('search.has')}</Label>
                <select
                  id={ids.has}
                  className={selectClass}
                  value={has}
                  onChange={(e) => setHas(e.target.value as typeof has)}
                >
                  <option value="">{t('search.hasAny')}</option>
                  <option value="file">{t('search.hasFile')}</option>
                  <option value="link">{t('search.hasLink')}</option>
                </select>
              </div>
            </div>
          </details>
        )}
      </div>
      <div id={`${ids.q}-${tab}`} role="tabpanel" className="flex flex-col px-3 pb-4">
        {q === '' ? (
          <p className="px-1 text-sm text-muted-foreground">
            {text.trim() === '' ? t('search.empty') : t('search.waiting')}
          </p>
        ) : tab === 'messages' ? (
          <MessageResults q={q} filters={filters} />
        ) : tab === 'files' ? (
          <FileResults q={q} workspaceId={scope === 'all' ? undefined : workspaceId} />
        ) : (
          <ContentResults q={q} workspaceId={scope === 'all' ? undefined : workspaceId} />
        )}
      </div>
    </aside>
  );
}

/** "From": pick a person by name. */
function FromFilter({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string;
  value: Person | null;
  onChange: (p: Person | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState('');
  const q = useSettled(text.trim(), 200);
  const people = useQuery(peopleQuery(workspaceId, q));
  if (value) {
    return (
      <div className="grid gap-1">
        <span className="text-sm font-medium">{t('search.from')}</span>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{value.display_name}</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('search.clearFrom', { name: value.display_name })}
            onClick={() => onChange(null)}
          >
            <XIcon strokeWidth={1.75} />
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{t('search.from')}</Label>
      <Input
        id={id}
        value={text}
        placeholder={t('search.fromPlaceholder')}
        onChange={(e) => setText(e.target.value)}
      />
      {q !== '' && (people.data?.length ?? 0) > 0 && (
        <ul className="flex flex-col" aria-label={t('search.people')}>
          {people.data!.slice(0, 5).map((p) => (
            <li key={p.id}>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  onChange(p);
                  setText('');
                }}
              >
                <span className="truncate">{p.display_name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useChannelName() {
  const channels = useQuery(channelsQuery);
  // Conversations are named after the people in them on this side.
  return (c: SearchMessage['channel']) => channels.data?.find((x) => x.id === c.id)?.name ?? c.name;
}

function Problem({
  error,
  retry,
  timeoutAction,
}: {
  error: unknown;
  retry: () => void;
  /** What to do when the search took too long, where filters can narrow it. */
  timeoutAction?: string;
}) {
  const { t } = useTranslation();
  const problem: ProblemLike = error instanceof ApiError ? error.problem : { status: 500 };
  return (
    <ErrorState
      problem={problem}
      action={problem.code === 'search_timeout' ? timeoutAction : undefined}
      actions={<Button onClick={retry}>{t('ui:errors.retry')}</Button>}
    />
  );
}

function MessageResults({ q, filters }: { q: string; filters: MessageFilters }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const jump = useJump((s) => s.jump);
  const openThread = useLayout((s) => s.openThread);
  const { isMobile } = useSidebar();
  const nameOf = useChannelName();
  const results = useInfiniteQuery(searchMessagesQuery(q, filters));
  const terms = searchTerms(q);
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  if (results.isPending) return <Skeleton className="h-16" />;
  if (results.isError)
    return (
      <Problem
        error={results.error}
        retry={() => void results.refetch()}
        timeoutAction={t('search.timeoutAction')}
      />
    );
  const list = results.data.pages.flatMap((p) => p.results);
  if (list.length === 0) {
    return (
      <p role="status" className="px-1 text-sm text-muted-foreground">
        {t('search.noMessages')}
      </p>
    );
  }
  const open = (m: SearchMessage) => {
    // On small screens the panel covers the channel: close it to show the message.
    if (isMobile) useLayout.getState().setDetailsOpen(false);
    void navigate({ to: '/c/$channelId', params: { channelId: m.channel.id } });
    // A reply opens its thread (the thread shows it highlighted).
    if (m.root_id) {
      openThread({ channelId: m.channel.id, rootId: m.root_id });
      useJump.getState().done(m.id);
      return;
    }
    jump({ channelId: m.channel.id, messageId: m.id });
  };
  return (
    <>
      <p role="status" className="sr-only">
        {t('search.found', { count: list.length })}
      </p>
      <ul className="flex flex-col gap-1">
        {list.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              data-testid="search-result"
              onClick={() => open(m)}
              className="flex w-full flex-col gap-1 rounded-lg px-2 py-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                <span className="truncate font-medium text-foreground">
                  {m.author.display_name}
                </span>
                <span className="truncate">
                  {m.channel.kind === 'direct' || m.channel.kind === 'group'
                    ? nameOf(m.channel)
                    : `#${nameOf(m.channel)}`}
                </span>
                <time dateTime={m.created_at} className="ms-auto shrink-0">
                  {date.format(new Date(m.created_at))}
                </time>
              </span>
              <span className="line-clamp-3 break-words">
                <Marked text={plainText(m.body)} terms={terms} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {results.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 self-start"
          disabled={results.isFetchingNextPage}
          onClick={() => void results.fetchNextPage()}
        >
          {t('search.more')}
        </Button>
      )}
    </>
  );
}

function FileResults({ q, workspaceId }: { q: string; workspaceId: string | undefined }) {
  const { t, i18n } = useTranslation();
  const nameOf = useChannelName();
  const results = useInfiniteQuery(searchFilesQuery(q, workspaceId));
  const terms = searchTerms(q);
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  if (results.isPending) return <Skeleton className="h-16" />;
  if (results.isError)
    return <Problem error={results.error} retry={() => void results.refetch()} />;
  const list: SearchFile[] = results.data.pages.flatMap((p) => p.results);
  if (list.length === 0) {
    return (
      <p role="status" className="px-1 text-sm text-muted-foreground">
        {t('search.noFiles')}
      </p>
    );
  }
  return (
    <>
      <p role="status" className="sr-only">
        {t('search.found', { count: list.length })}
      </p>
      <ul className="flex flex-col gap-1">
        {list.map((f) => (
          <li key={f.id} data-testid="search-file" className="flex items-center gap-2 text-sm">
            <FileTypeIcon file={f} className="size-9 shrink-0 p-1.5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <a
                href={fileUrl(f.id)}
                target="_blank"
                rel="noopener"
                className="flex min-h-target items-center hover:underline"
              >
                <span className="truncate">
                  <Marked text={f.name} terms={terms} />
                </span>
              </a>
              {f.excerpt && (
                <p className="line-clamp-2 text-xs" data-testid="search-file-excerpt">
                  <Excerpt text={f.excerpt} />
                </p>
              )}
              <p className="truncate text-xs text-muted-foreground">
                {f.uploader.display_name} · {nameOf(f.channel)} ·{' '}
                {date.format(new Date(f.created_at))} · {formatSize(f.size, i18n.language)}
              </p>
            </div>
            <a
              href={fileUrl(f.id, true)}
              download={f.name}
              aria-label={t('files.downloadNamed', { name: f.name })}
              className={buttonVariants({ size: 'icon-sm', variant: 'ghost' })}
            >
              <DownloadIcon aria-hidden strokeWidth={1.75} />
            </a>
          </li>
        ))}
      </ul>
      {results.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 self-start"
          disabled={results.isFetchingNextPage}
          onClick={() => void results.fetchNextPage()}
        >
          {t('search.more')}
        </Button>
      )}
    </>
  );
}

/** The words the server matched, between « and », marked. */
function Excerpt({ text }: { text: string }) {
  return (
    <>
      {excerptParts(text).map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded-sm bg-mention-bg px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Canvases and list rows that match, opening their tab. */
function ContentResults({ q, workspaceId }: { q: string; workspaceId: string | undefined }) {
  const { t, i18n } = useTranslation();
  const nameOf = useChannelName();
  const navigate = useNavigate();
  const results = useQuery(searchContentQuery(q, workspaceId));
  const terms = searchTerms(q);
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  if (results.isPending) return <Skeleton className="h-16" />;
  if (results.isError)
    return <Problem error={results.error} retry={() => void results.refetch()} />;
  const { canvases, items } = results.data;
  if (canvases.length === 0 && items.length === 0) {
    return (
      <p role="status" className="px-1 text-sm text-muted-foreground">
        {t('search.noContent')}
      </p>
    );
  }
  const open = (channelId: string, tab: string) =>
    void navigate({ to: '/c/$channelId', params: { channelId }, search: { tab } });
  return (
    <>
      <p role="status" className="sr-only">
        {t('search.found', { count: canvases.length + items.length })}
      </p>
      {canvases.length > 0 && (
        <section aria-label={t('search.canvases')} className="flex flex-col gap-1">
          <h3 className="px-1 pt-1 text-xs font-medium text-muted-foreground">
            {t('search.canvases')}
          </h3>
          <ul className="flex flex-col gap-1" data-testid="search-canvases">
            {canvases.map((c) => (
              <li key={c.tab_id}>
                <button
                  type="button"
                  className="flex w-full min-h-target flex-col items-start rounded-md px-1 py-1 text-start text-sm hover:bg-muted"
                  onClick={() => open(c.channel.id, c.tab_id)}
                >
                  <span className="font-medium">
                    <Marked text={c.title} terms={terms} />
                  </span>
                  {c.excerpt && (
                    <span className="line-clamp-2 text-xs">
                      <Excerpt text={c.excerpt} />
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {nameOf(c.channel)} · {date.format(new Date(c.updated_at))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {items.length > 0 && (
        <section aria-label={t('search.listItems')} className="flex flex-col gap-1 pt-2">
          <h3 className="px-1 text-xs font-medium text-muted-foreground">
            {t('search.listItems')}
          </h3>
          <ul className="flex flex-col gap-1" data-testid="search-items">
            {items.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="flex w-full min-h-target flex-col items-start rounded-md px-1 py-1 text-start text-sm hover:bg-muted"
                  onClick={() => open(i.channel.id, i.tab_id)}
                >
                  <span>
                    <Marked text={i.title} terms={terms} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {i.list_title} · {nameOf(i.channel)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
