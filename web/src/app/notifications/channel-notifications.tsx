// SPDX-License-Identifier: Apache-2.0
import { useId } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Label } from '@cenacle/ui/components/label';
import type { Channel } from '../chat/data';
import {
  FOREVER,
  isActive,
  notificationsQuery,
  setChannelNotifications,
  soundsQuery,
  untilOf,
  type ChannelNotification,
  type NotificationSettings,
} from './notifications';
import { BUILTIN_SOUNDS } from './sounds';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const MUTES = ['1h', '8h', 'tomorrow', 'week', 'forever'] as const;

/** A channel's notification settings for the person, from the loaded settings. */
function useChannelNotification(channelId: string) {
  const settings = useQuery(notificationsQuery);
  const own = settings.data?.channels.find((c) => c.channel_id === channelId);
  return {
    level: own?.level ?? 'default',
    muted_until: own?.muted_until ?? null,
    sound: own?.sound ?? '',
    muted: isActive(own?.muted_until),
  } as const;
}

/** Saves a channel's notification settings, showing them at once. */
function useSetChannelNotification() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      n,
    }: {
      channelId: string;
      n: Omit<ChannelNotification, 'channel_id'>;
    }) => setChannelNotifications(channelId, n),
    onMutate: ({ channelId, n }) => {
      queryClient.setQueryData<NotificationSettings>(notificationsQuery.queryKey, (s) =>
        s
          ? {
              ...s,
              channels: [
                ...s.channels.filter((c) => c.channel_id !== channelId),
                { channel_id: channelId, ...n },
              ],
            }
          : s,
      );
    },
    onError: () => {
      toast.error(t('notifications.saveFailed'));
      void queryClient.invalidateQueries({ queryKey: notificationsQuery.queryKey });
    },
  });
}

/** In the channel details: what notifies, muting and the channel's sound. */
export function ChannelNotificationsSection({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const ids = { level: useId(), mute: useId(), sound: useId() };
  const current = useChannelNotification(channel.id);
  const sounds = useQuery(soundsQuery);
  const set = useSetChannelNotification();
  const conversation = channel.kind === 'direct' || channel.kind === 'group';
  const save = (patch: Partial<Omit<ChannelNotification, 'channel_id'>>) =>
    set.mutate({
      channelId: channel.id,
      n: { level: current.level, muted_until: current.muted_until, sound: current.sound, ...patch },
    });
  const until = current.muted && current.muted_until !== FOREVER ? current.muted_until : null;

  return (
    <section
      aria-labelledby={`${ids.level}-title`}
      className="flex flex-col gap-2"
      data-testid="channel-notifications"
    >
      <h3 id={`${ids.level}-title`} className="text-xs font-medium text-muted-foreground uppercase">
        {t('notifications.title')}
      </h3>
      <div className="grid gap-1">
        <Label htmlFor={ids.level}>{t('notifications.notifyMe')}</Label>
        <select
          id={ids.level}
          className={selectClass}
          value={current.level}
          onChange={(e) => save({ level: e.target.value as ChannelNotification['level'] })}
        >
          <option value="default">
            {conversation
              ? t('notifications.levels.defaultConversation')
              : t('notifications.levels.default')}
          </option>
          {(['all', 'mentions', 'none'] as const).map((l) => (
            <option key={l} value={l}>
              {t(`notifications.levels.${l}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={ids.mute}>
          {conversation ? t('notifications.muteConversation') : t('notifications.muteChannel')}
        </Label>
        <select
          id={ids.mute}
          className={selectClass}
          value={current.muted ? 'muted' : ''}
          onChange={(e) => {
            const v = e.target.value;
            save({ muted_until: v === '' ? null : untilOf(v as (typeof MUTES)[number]) });
          }}
        >
          <option value="">{t('notifications.notMuted')}</option>
          {current.muted && (
            <option value="muted" disabled>
              {until
                ? t('notifications.mutedUntil', {
                    time: new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }).format(new Date(until)),
                  })
                : t('notifications.mutedForGood')}
            </option>
          )}
          {MUTES.map((m) => (
            <option key={m} value={m}>
              {t(`notifications.durations.${m}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={ids.sound}>{t('notifications.channelSound')}</Label>
        <select
          id={ids.sound}
          className={selectClass}
          value={current.sound}
          onChange={(e) => save({ sound: e.target.value })}
        >
          <option value="">{t('notifications.sounds.default')}</option>
          <option value="none">{t('notifications.sounds.none')}</option>
          {BUILTIN_SOUNDS.map((s) => (
            <option key={s} value={s}>
              {t(`notifications.sounds.${s}`)}
            </option>
          ))}
          {(sounds.data ?? []).map((s) => (
            <option key={s.id} value={`user:${s.id}`}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
