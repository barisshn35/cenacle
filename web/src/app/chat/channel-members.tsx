// SPDX-License-Identifier: Apache-2.0
import { useDeferredValue, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserMinusIcon, UserPlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { useSession } from '../auth/session';
import { initials } from '../auth/sign-out';
import {
  addMember,
  membersQuery,
  peopleQuery,
  removeMember,
  type Channel,
  type Person,
} from './data';

function PersonLine({ person, badge }: { person: Person; badge?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold"
      >
        {initials(person.display_name || person.email)}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm">
          {person.display_name || person.email}
          {badge && <span className="ml-2 text-xs text-muted-foreground">{badge}</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">{person.email}</p>
      </div>
    </div>
  );
}

/** Public or private, with what that means. Managers change it in the channel settings. */
export function VisibilitySetting({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  return (
    <p>
      {t(`channels.visibility.${channel.visibility}`)}
      <span className="block text-xs text-muted-foreground">
        {t(`channels.visibility.${channel.visibility}Hint`)}
      </span>
    </p>
  );
}

/** Members of a channel; managers add and remove people. */
export function MembersSection({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const members = useQuery(membersQuery(channel.id));
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const canEdit = channel.can_manage && !channel.is_mandatory;

  const remove = useMutation({
    mutationFn: (person: Person) => removeMember(channel.id, person.id),
    onSuccess: (_, person) => {
      void queryClient.invalidateQueries({ queryKey: ['members', channel.id] });
      showUndoToast({
        message: t('channels.removed', {
          person: person.display_name || person.email,
          channel: channel.name,
        }),
        onUndo: async () => {
          await addMember(channel.id, person.id);
          await queryClient.invalidateQueries({ queryKey: ['members', channel.id] });
        },
      });
    },
    onError: () => toast.error(t('channels.changeFailed')),
  });

  return (
    <section aria-labelledby={`members-${channel.id}`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3
          id={`members-${channel.id}`}
          className="text-xs font-medium text-muted-foreground uppercase"
        >
          {members.data
            ? t('channels.membersCount', { count: members.data.length })
            : t('channels.members')}
        </h3>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <UserPlusIcon aria-hidden strokeWidth={1.75} />
            {t('channels.addPeople')}
          </Button>
        )}
      </div>
      {members.isPending ? (
        <div aria-hidden className="grid gap-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : members.isError ? (
        <InlineError
          problem={members.error instanceof ApiError ? members.error.problem : { status: 0 }}
        />
      ) : (
        <ul className="flex flex-col gap-1" data-testid="members">
          {members.data.map((m) => (
            <li key={m.user.id} className="flex items-center gap-2">
              <PersonLine
                person={m.user}
                badge={m.role === 'manager' ? t('channels.manager') : undefined}
              />
              {canEdit && m.user.id !== user.id && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('channels.removeNamed', {
                    person: m.user.display_name || m.user.email,
                  })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(m.user)}
                >
                  <UserMinusIcon strokeWidth={1.75} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <AddPeopleDialog
          channel={channel}
          memberIds={new Set(members.data?.map((m) => m.user.id))}
          open={adding}
          onOpenChange={setAdding}
        />
      )}
    </section>
  );
}

function AddPeopleDialog({
  channel,
  memberIds,
  open,
  onOpenChange,
}: {
  channel: Channel;
  memberIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const people = useQuery({ ...peopleQuery(query), enabled: open && query !== '' });
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (person: Person) => addMember(channel.id, person.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', channel.id] }),
    onError: () => toast.error(t('channels.changeFailed')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('channels.addPeopleTo', { channel: channel.name })}</DialogTitle>
          <DialogDescription>
            {channel.visibility === 'private'
              ? t('channels.addPeoplePrivate')
              : t('channels.addPeoplePublic')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={id}>{t('channels.findPeople')}</Label>
          <Input
            id={id}
            type="search"
            value={q}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <ul aria-live="polite" className="-mx-1 grid max-h-[50svh] gap-1 overflow-y-auto">
          {(people.data ?? []).map((person) => {
            const member = memberIds.has(person.id);
            return (
              <li key={person.id} className="flex items-center gap-2 px-1">
                <PersonLine person={person} />
                {member ? (
                  <span className="text-xs text-muted-foreground">
                    {t('channels.alreadyMember')}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={add.isPending}
                    aria-label={t('channels.addNamed', {
                      person: person.display_name || person.email,
                    })}
                    onClick={() => add.mutate(person)}
                  >
                    {t('channels.add')}
                  </Button>
                )}
              </li>
            );
          })}
          {query !== '' && people.data?.length === 0 && (
            <li className="px-1 text-sm text-muted-foreground">{t('channels.noPeople')}</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
