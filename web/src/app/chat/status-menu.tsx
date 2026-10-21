// SPDX-License-Identifier: Apache-2.0
import { CheckIcon } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { useSession } from '../auth/session';
import { PresenceIndicator } from '../shell/presence';
import { setPresence, type PresenceStatus } from './data';
import { useLive, usePresence } from './presence-state';

const CHOICES = ['online', 'away', 'dnd'] as const;

/** The user's avatar with their status; it opens the status choices. */
export function StatusMenu({ initials }: { initials: string }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
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
        // The initials are drawn with CSS: they are decoration, and the
        // button's name is the status (axe label-content-name-mismatch).
        data-initials={initials}
        className="hit-target flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground outline-none after:content-[attr(data-initials)] focus-visible:ring-2 focus-visible:ring-ring"
      >
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
