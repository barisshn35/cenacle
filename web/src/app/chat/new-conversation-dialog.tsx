// SPDX-License-Identifier: AGPL-3.0-only
import { useDeferredValue, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { ApiError } from '@cenacle/core/api';
import { useSession } from '../auth/session';
import { PersonLine } from './channel-members';
import {
  openConversation,
  peopleQuery,
  reloadChannels,
  setConversationTitle,
  type Person,
} from './data';
import { MAX_TITLE } from './group-title';

/** Up to this many others in a group conversation (the server's limit). */
const MAX_PEOPLE = 8;

/**
 * Starts a conversation: pick one person for a direct conversation or up to
 * eight for a group. The same people always get the same conversation back.
 */
export function NewConversationDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const self = useSession().user.id;
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Person[]>([]);
  const [title, setTitle] = useState('');
  const query = useDeferredValue(q.trim());
  const people = useQuery({ ...peopleQuery(workspaceId, query), enabled: open && query !== '' });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: async () => {
      const channel = await openConversation(
        workspaceId,
        picked.map((p) => p.id),
      );
      // A group may be named as it starts (an existing one keeps its name unless one is given).
      if (picked.length > 1 && title.trim()) return setConversationTitle(channel.id, title.trim());
      return channel;
    },
    onSuccess: async (channel) => {
      await reloadChannels(queryClient);
      onOpenChange(false);
      void navigate({ to: '/c/$channelId', params: { channelId: channel.id } });
    },
  });
  const full = picked.length >= MAX_PEOPLE;
  const results = (people.data ?? []).filter(
    (p) => p.id !== self && !picked.some((x) => x.id === p.id),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dm.newTitle')}</DialogTitle>
          <DialogDescription>{t('dm.newDescription')}</DialogDescription>
        </DialogHeader>
        {picked.length > 0 && (
          <ul aria-label={t('dm.picked')} className="flex flex-wrap gap-1.5">
            {picked.map((p) => (
              <li key={p.id}>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t('dm.unpick', { person: p.display_name || p.email })}
                  onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                >
                  {p.display_name || p.email}
                  <XIcon aria-hidden strokeWidth={1.75} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2">
          <Label htmlFor={id}>{t('channels.findPeople')}</Label>
          <Input
            id={id}
            type="search"
            value={q}
            autoComplete="off"
            disabled={full}
            onChange={(e) => setQ(e.target.value)}
          />
          {full && (
            <p className="text-xs text-muted-foreground">{t('dm.full', { count: MAX_PEOPLE })}</p>
          )}
        </div>
        <ul aria-live="polite" className="-mx-1 grid max-h-[40svh] gap-1 overflow-y-auto">
          {!full &&
            results.map((person) => (
              <li key={person.id} className="flex items-center gap-2 px-1">
                <PersonLine person={person} />
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={t('dm.pick', { person: person.display_name || person.email })}
                  onClick={() => {
                    setPicked([...picked, person]);
                    setQ('');
                  }}
                >
                  {t('channels.add')}
                </Button>
              </li>
            ))}
          {query !== '' && people.data && results.length === 0 && !full && (
            <li className="px-1 text-sm text-muted-foreground">{t('channels.noPeople')}</li>
          )}
        </ul>
        {picked.length > 1 && (
          <div className="grid gap-2">
            <Label htmlFor={`${id}-title`}>{t('dm.naming.optional')}</Label>
            <Input
              id={`${id}-title`}
              value={title}
              maxLength={MAX_TITLE}
              autoComplete="off"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        )}
        {start.isError && (
          <InlineError
            problem={start.error instanceof ApiError ? start.error.problem : { status: 500 }}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('ui:confirm.cancel')}
          </Button>
          <Button
            disabled={picked.length === 0 || start.isPending}
            aria-busy={start.isPending || undefined}
            onClick={() => start.mutate()}
          >
            {t('dm.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
