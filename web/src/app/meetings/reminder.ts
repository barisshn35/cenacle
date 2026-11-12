// SPDX-License-Identifier: AGPL-3.0-only
import i18next from 'i18next';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { NotificationSettings } from '../notifications/notifications';
import { notificationsQuery } from '../notifications/notifications';
import { inFront, systemNotification } from '../notifications/notifier';
import { playSound } from '../notifications/sounds';
import { dateLocale } from '../../i18n/time-format';

/** The data of a meeting.reminder event. */
export interface MeetingReminder {
  meeting_id: string;
  channel_id: string;
  title: string;
  starts_at: string;
}

/**
 * A meeting starts soon: a toast that opens it (with Join), and the system's
 * notification while the app is behind other windows.
 */
export function notifyMeetingReminder(
  queryClient: QueryClient,
  r: MeetingReminder,
  openMeeting: (id: string) => void,
): void {
  const settings = queryClient.getQueryData<NotificationSettings>(notificationsQuery.queryKey);
  if (settings) playSound(settings.prefs.sounds.mention, settings.prefs.volume);
  const at = new Intl.DateTimeFormat(dateLocale(i18next.language), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(r.starts_at));
  const title = i18next.t('meetings.reminder.title', { title: r.title });
  const body = i18next.t('meetings.reminder.body', { time: at });
  toast(title, {
    id: `meeting-${r.meeting_id}`,
    description: body,
    duration: 60_000,
    action: {
      label: i18next.t('meetings.reminder.open'),
      onClick: () => openMeeting(r.meeting_id),
    },
  });
  if (!inFront()) {
    systemNotification(
      { title, body, tag: `meeting-${r.meeting_id}`, channelId: r.channel_id, sticky: true },
      () => openMeeting(r.meeting_id),
    );
  }
}
