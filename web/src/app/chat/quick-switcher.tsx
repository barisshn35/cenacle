// SPDX-License-Identifier: AGPL-3.0-only
import { useDeferredValue, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '@cenacle/ui/components/dialog';
import { cn } from '@cenacle/ui/lib/utils';
import { ChannelIcon } from './channel-icon';
import { useActiveWorkspace } from './active-workspace';
import {
  channelsQuery,
  directoryQuery,
  isConversation,
  openConversation,
  peopleQuery,
  reloadChannels,
  type Channel,
  type Person,
} from './data';
import { useQuickSwitcher } from './quick-switcher-state';
import { useSession } from '../auth/session';
import { UserAvatar } from '../profile/avatar';

type Result = { kind: 'channel'; channel: Channel } | { kind: 'person'; person: Person };
const resultId = (r: Result) => (r.kind === 'channel' ? r.channel.id : `person-${r.person.id}`);

/** Case- and accent-insensitive text for matching ("Genel" finds "genel", "ç" finds "c"). */
function fold(s: string): string {
  return s.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

/**
 * Jump to a channel, a conversation or a person by typing part of the name:
 * the user's channels and conversations first, then people to write to, then
 * public channels to join. A combobox with a list (ARIA 1.2 pattern).
 */
export function QuickSwitcher() {
  const { t } = useTranslation();
  const { open, setOpen } = useQuickSwitcher();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const { id: workspaceId } = useActiveWorkspace();
  const directory = useQuery({ ...directoryQuery(workspaceId), enabled: open && !!workspaceId });
  const mine = useQuery({ ...channelsQuery, enabled: open });
  const query = useDeferredValue(q.trim());
  const people = useQuery({
    ...peopleQuery(workspaceId ?? '', query),
    enabled: open && !!workspaceId && query !== '',
  });
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const results = useMemo((): Result[] => {
    const needle = fold(q.trim());
    const matches = (name: string) => needle === '' || fold(name).includes(needle);
    const conversations = (mine.data ?? []).filter(
      (c) => isConversation(c) && c.workspace_id === workspaceId && matches(c.name),
    );
    const channels = (directory.data ?? []).filter(
      (c) => (!c.archived || c.is_member) && matches(c.name),
    );
    // Someone the user already has a direct conversation with shows as that conversation.
    const talking = new Set(
      (mine.data ?? []).flatMap((c) =>
        c.kind === 'direct' ? c.participants.map((p) => p.id) : [],
      ),
    );
    const persons = needle
      ? (people.data ?? []).filter((p) => p.id !== self && !talking.has(p.id))
      : [];
    return [
      ...channels
        .filter((c) => c.is_member)
        .map((channel) => ({ kind: 'channel' as const, channel })),
      ...conversations.map((channel) => ({ kind: 'channel' as const, channel })),
      ...persons.map((person) => ({ kind: 'person' as const, person })),
      ...channels
        .filter((c) => !c.is_member)
        .map((channel) => ({ kind: 'channel' as const, channel })),
    ].slice(0, 20);
  }, [directory.data, mine.data, people.data, q, self, workspaceId]);

  const close = () => {
    setOpen(false);
    setQ('');
  };
  const go = (r: Result | undefined) => {
    if (!r) return;
    close();
    if (r.kind === 'channel') {
      void navigate({ to: '/c/$channelId', params: { channelId: r.channel.id } });
      return;
    }
    // Opens the conversation with that person (the same one every time).
    void openConversation(workspaceId ?? '', [r.person.id]).then(async (channel) => {
      await reloadChannels(queryClient);
      void navigate({ to: '/c/$channelId', params: { channelId: channel.id } });
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ('');
      }}
    >
      <DialogContent
        className="top-[20%] translate-y-0 gap-2 p-2 sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t('switcher.title')}</DialogTitle>
        <input
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            results[active] ? `${listId}-${resultId(results[active])}` : undefined
          }
          aria-label={t('switcher.title')}
          placeholder={t('switcher.placeholder')}
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="min-h-11 w-full rounded-lg bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground"
        />
        <ul
          id={listId}
          role="listbox"
          aria-label={t('switcher.results')}
          className="grid max-h-80 gap-0.5 overflow-y-auto"
        >
          {results.map((r, i) => (
            // Keys go to the combobox input (focus stays there); the mouse can pick too.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={resultId(r)}
              id={`${listId}-${resultId(r)}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => go(r)}
              className={cn(
                'flex min-h-target cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm',
                i === active && 'bg-accent text-accent-foreground',
              )}
            >
              {r.kind === 'channel' ? (
                <>
                  <ChannelIcon
                    channel={r.channel}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="flex-1 truncate">{r.channel.name}</span>
                  {!r.channel.is_member && (
                    <span className="text-xs text-muted-foreground">{t('switcher.notJoined')}</span>
                  )}
                  {r.channel.archived && (
                    <span className="text-xs text-muted-foreground">{t('switcher.archived')}</span>
                  )}
                </>
              ) : (
                <>
                  <UserAvatar
                    userId={r.person.id}
                    name={r.person.display_name}
                    size="xs"
                    className="shrink-0"
                  />
                  <span className="flex-1 truncate">{r.person.display_name}</span>
                  <span className="text-xs text-muted-foreground">{t('switcher.person')}</span>
                </>
              )}
            </li>
          ))}
          {directory.isSuccess && results.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">{t('switcher.empty')}</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
