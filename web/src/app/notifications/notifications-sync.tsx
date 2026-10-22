// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { myProfileQuery } from '../profile/profiles';
import { notificationsQuery } from './notifications';

/** Keeps what incoming messages are checked against loaded (settings, time zone). */
export function NotificationsSync() {
  useQuery(notificationsQuery);
  useQuery(myProfileQuery);
  return null;
}
