// SPDX-License-Identifier: AGPL-3.0-only
import {
  LockIcon,
  MegaphoneIcon,
  NewspaperIcon,
  UserIcon,
  UsersIcon,
  type LucideProps,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Channel } from './data';

/**
 * The speech bubble of the Cenacle logo, drawn like a lucide icon (24px grid,
 * same stroke): the sign of a public channel, never "#" (ADR 0031).
 */
export function BubbleIcon({ strokeWidth = 2, className, ...props }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <path d="M5 20.5V11A7 7 0 0 1 12 4h0.5A7 7 0 0 1 19.5 11v2.5A7 7 0 0 1 12.5 20.5Z" />
    </svg>
  );
}

/**
 * Icon of a channel: the logo's bubble for public channels, a lock for
 * private ones, a megaphone for announcements, a newspaper for forums, one or
 * more people for direct and group conversations.
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
          : channel.kind === 'forum'
            ? [NewspaperIcon, t('channels.kinds.forum')]
            : channel.visibility === 'private'
              ? [LockIcon, t('channels.kinds.private')]
              : [BubbleIcon, t('channels.kinds.standard')];
  return labelled ? (
    <Icon aria-label={label} role="img" strokeWidth={1.75} className={className} />
  ) : (
    <Icon aria-hidden strokeWidth={1.75} className={className} />
  );
}
