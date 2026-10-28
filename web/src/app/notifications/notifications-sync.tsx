// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { myProfileQuery } from '../profile/profiles';
import { notificationsQuery } from './notifications';
import { renewPush } from './push';

/** Keeps what incoming messages are checked against loaded (settings, time zone). */
export function NotificationsSync() {
  const settings = useQuery(notificationsQuery);
  useQuery(myProfileQuery);
  const renew = Boolean(settings.data?.prefs.push && settings.data.push_public_key);
  // Push subscriptions end with the session that made them; this one renews them.
  useEffect(() => {
    if (renew) void renewPush();
  }, [renew]);
  return null;
}
