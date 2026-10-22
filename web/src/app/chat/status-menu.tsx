// SPDX-License-Identifier: Apache-2.0
import { CheckIcon, PencilIcon, SmileIcon } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { Avatar } from '../profile/avatar';
import { useProfileDialogs } from '../profile/dialogs-state';
import { useProfile } from '../profile/profiles';
import { useSession } from '../auth/session';
import { PresenceIndicator } from '../shell/presence';
import { setPresence, type PresenceStatus } from './data';
import { useLive, usePresence } from './presence-state';

const CHOICES = ['online', 'away', 'dnd'] as const;

/** The user's picture with their status; it opens the status choices and the profile. */
export function StatusMenu({ name }: { name: string }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const profile = useProfile(self);
  const openDialog = useProfileDialogs((s) => s.open);
  const status = usePresence(self);
  const set = useMutation({
    mutationFn: (s: Exclude<PresenceStatus, 'offline'>) => setPresence(s),
    onMutate: (s) => {
      const before = useLive.getState().presence[self];
      useLive.getState().setPresence(self, s);
      return before;
    },
    onError: (_err, _s, before) => {
      useLive.getState().setPresence(self, before ?? 'offline');
      toast.error(t('presence.failed'));
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('presence.change', { status: t(`shell.presence.${status}`) })}
        className="hit-target relative flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Decoration: the button's name is the status. */}
        <Avatar name={name} profile={profile} size="sm" className="size-8" cssInitials />
        <PresenceIndicator presence={status} className="absolute -right-1 -bottom-1" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        {CHOICES.map((choice) => (
          <DropdownMenuItem key={choice} onClick={() => set.mutate(choice)}>
            <PresenceIndicator presence={choice} className="bg-transparent" />
            <span className="flex-1">{t(`shell.presence.${choice}`)}</span>
            {status === choice && <CheckIcon aria-hidden strokeWidth={1.75} />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openDialog('status')}>
          <SmileIcon aria-hidden strokeWidth={1.75} />
          {profile?.status ? t('profile.statusChange') : t('profile.statusSet')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openDialog('edit')}>
          <PencilIcon aria-hidden strokeWidth={1.75} />
          {t('profile.edit')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
