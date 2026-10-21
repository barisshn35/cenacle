// SPDX-License-Identifier: Apache-2.0
import { LockIcon, MegaphoneIcon, MessagesSquareIcon, UserIcon, UsersIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Channel } from './data';

/**
 * Icon of a channel: megaphone for announcements, lock for private channels,
 * one or more people for direct and group conversations.
 * With `labelled` it tells the kind to screen readers.
 */
export function ChannelIcon({
  channel,
  labelled = false,
  className,
}: {
  channel: Pick<Channel, 'kind' | 'visibility'>;
  labelled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [Icon, label] =
    channel.kind === 'announcement'
      ? [MegaphoneIcon, t('channels.kinds.announcement')]
      : channel.kind === 'direct'
        ? [UserIcon, t('channels.kinds.direct')]
        : channel.kind === 'group'
          ? [UsersIcon, t('channels.kinds.group')]
          : channel.visibility === 'private'
            ? [LockIcon, t('channels.kinds.private')]
            : [MessagesSquareIcon, t('channels.kinds.standard')];
  return labelled ? (
    <Icon aria-label={label} role="img" strokeWidth={1.75} className={className} />
  ) : (
    <Icon aria-hidden strokeWidth={1.75} className={className} />
  );
}
