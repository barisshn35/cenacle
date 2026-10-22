// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ClockIcon, MailIcon, MessageSquareIcon, PencilIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@cenacle/ui/components/popover';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import { BotBadge } from '../chat/bot-badge';
import { openConversation, reloadChannels } from '../chat/data';
import { usePresence } from '../chat/presence-state';
import { PresenceIndicator } from '../shell/presence';
import { Avatar } from './avatar';
import { useProfileDialogs } from './dialogs-state';
import { sinceText } from './format';
import { localTime, useProfile, type CustomStatus } from './profiles';

/** The emoji and text of a custom status, as one line. */
export function StatusLine({ status, className }: { status: CustomStatus; className?: string }) {
  const { t, i18n } = useTranslation();
  const until = status.expires_at
    ? new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(
        new Date(status.expires_at),
      )
    : null;
  return (
    <p className={className} data-testid="custom-status">
      {status.emoji && <span className="mr-1">{status.emoji}</span>}
      {status.text}
      {until && (
        <span className="text-muted-foreground"> · {t('profile.until', { time: until })}</span>
      )}
    </p>
  );
}

/**
 * A person's card: picture with presence, name, @username, custom status,
 * local time and address; one's own opens "Edit profile", another person's
 * starts a conversation. It opens from the trigger (a name or picture).
 */
export function ProfileCard({
  userId,
  name,
  children,
}: {
  userId: string;
  name: string;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={children} />
      <PopoverContent align="start" side="right" className="w-72 p-0">
        {open && <CardBody userId={userId} name={name} onDone={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function CardBody({ userId, name, onDone }: { userId: string; name: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const self = useSession().user.id;
  const profile = useProfile(userId);
  const presence = usePresence(userId);
  const { id: workspaceId } = useActiveWorkspace();
  const openDialog = useProfileDialogs((s) => s.open);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const message = useMutation({
    mutationFn: () => openConversation(workspaceId!, [userId]),
    onSuccess: async (channel) => {
      await reloadChannels(queryClient);
      onDone();
      void navigate({ to: '/c/$channelId', params: { channelId: channel.id } });
    },
    onError: () => toast.error(t('profile.messageFailed')),
  });
  const shown = profile?.display_name || name;
  const time = profile ? localTime(profile.timezone, i18n.language) : null;
  const lastSeen =
    presence === 'offline' && profile?.last_seen_at
      ? sinceText(new Date(profile.last_seen_at), i18n.language)
      : null;
  const isSelf = userId === self;

  return (
    <div className="flex flex-col" data-testid="profile-card">
      <div className="flex flex-col items-center gap-2 px-4 pt-5 pb-3 text-center">
        <span className="relative">
          <Avatar name={shown} profile={profile} size="lg" />
          {!profile?.is_bot && (
            <PresenceIndicator
              presence={presence}
              className="absolute right-0.5 bottom-0.5 size-4 bg-popover [&_svg]:size-3.5"
            />
          )}
        </span>
        <div className="flex flex-col items-center gap-0.5">
          <PopoverTitle className="flex items-center gap-1.5 text-base font-semibold">
            {shown}
            {profile?.is_bot && <BotBadge />}
          </PopoverTitle>
          {profile?.username && (
            <p className="text-sm text-muted-foreground">@{profile.username}</p>
          )}
          {profile?.guest && (
            <span className="rounded bg-muted px-1.5 py-px text-[11px] font-medium">
              {t('workspaces.roles.guest')}
            </span>
          )}
        </div>
        {profile?.status && <StatusLine status={profile.status} className="text-sm" />}
      </div>
      <dl className="flex flex-col gap-2 border-t px-4 py-3 text-sm">
        {!profile?.is_bot && (
          <div className="flex items-center gap-2">
            <dt className="sr-only">{t('profile.presence')}</dt>
            <dd className="flex items-center gap-2">
              <PresenceIndicator presence={presence} className="bg-transparent" />
              {t(`shell.presence.${presence}`)}
              {lastSeen && (
                <span className="text-muted-foreground">
                  · {t('profile.lastSeen', { when: lastSeen })}
                </span>
              )}
            </dd>
          </div>
        )}
        {profile?.deactivated && (
          <p className="text-muted-foreground">{t('profile.deactivated')}</p>
        )}
        {time && (
          <div className="flex items-center gap-2">
            <dt>
              <ClockIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.75} />
              <span className="sr-only">{t('profile.localTime')}</span>
            </dt>
            <dd>{t('profile.localTimeValue', { time })}</dd>
          </div>
        )}
        {profile?.email && (
          <div className="flex min-w-0 items-center gap-2">
            <dt>
              <MailIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.75} />
              <span className="sr-only">{t('profile.email')}</span>
            </dt>
            <dd className="min-w-0 truncate">
              <a
                href={`mailto:${profile.email}`}
                className="inline-flex min-h-target items-center underline-offset-4 hover:underline"
              >
                {profile.email}
              </a>
            </dd>
          </div>
        )}
      </dl>
      <div className="border-t p-3">
        {isSelf ? (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              onDone();
              openDialog('edit');
            }}
          >
            <PencilIcon aria-hidden strokeWidth={1.75} />
            {t('profile.edit')}
          </Button>
        ) : (
          !profile?.is_bot &&
          !profile?.deactivated &&
          workspaceId && (
            <Button
              className="w-full"
              disabled={message.isPending}
              onClick={() => message.mutate()}
            >
              <MessageSquareIcon aria-hidden strokeWidth={1.75} />
              {t('profile.message')}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
