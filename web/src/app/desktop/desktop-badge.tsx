// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { channelsQuery, isConversation } from '../chat/data';
import { desktop } from './desktop';

/**
 * The count on the desktop app's taskbar button: mentions of the person and
 * unread direct messages, as the sidebar's red counts.
 */
export function DesktopBadge() {
  const channels = useQuery({ ...channelsQuery, enabled: !!desktop }).data;
  const count = (channels ?? []).reduce(
    (n, c) => n + (isConversation(c) ? c.unread_count : c.mention_count),
    0,
  );
  useEffect(() => {
    if (desktop && channels) void desktop.setBadge(count);
  }, [count, channels]);
  return null;
}
