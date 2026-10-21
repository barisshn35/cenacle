// SPDX-License-Identifier: Apache-2.0
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '@cenacle/ui/components/dialog';
import { cn } from '@cenacle/ui/lib/utils';
import { ChannelIcon } from './channel-icon';
import { directoryQuery, type Channel } from './data';
import { useQuickSwitcher } from './quick-switcher-state';

/** Case- and accent-insensitive text for matching ("Genel" finds "genel", "ç" finds "c"). */
function fold(s: string): string {
  return s.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

/**
 * Jump to a channel by typing part of its name: the user's channels first,
 * then public channels to join. A combobox with a list (ARIA 1.2 pattern).
 */
export function QuickSwitcher() {
  const { t } = useTranslation();
  const { open, setOpen } = useQuickSwitcher();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const directory = useQuery({ ...directoryQuery, enabled: open });
  const navigate = useNavigate();

  const results = useMemo(() => {
    const needle = fold(q.trim());
    return (directory.data ?? [])
      .filter((c) => !c.archived || c.is_member)
      .filter((c) => needle === '' || fold(c.name).includes(needle))
      .sort((a, b) => Number(b.is_member) - Number(a.is_member))
      .slice(0, 20);
  }, [directory.data, q]);

  const go = (c: Channel | undefined) => {
    if (!c) return;
    setOpen(false);
    setQ('');
    void navigate({ to: '/c/$channelId', params: { channelId: c.id } });
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
          aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
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
          {results.map((c, i) => (
            // Keys go to the combobox input (focus stays there); the mouse can pick too.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={c.id}
              id={`${listId}-${c.id}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => go(c)}
              className={cn(
                'flex min-h-target cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm',
                i === active && 'bg-accent text-accent-foreground',
              )}
            >
              <ChannelIcon channel={c} className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{c.name}</span>
              {!c.is_member && (
                <span className="text-xs text-muted-foreground">{t('switcher.notJoined')}</span>
              )}
              {c.archived && (
                <span className="text-xs text-muted-foreground">{t('switcher.archived')}</span>
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
