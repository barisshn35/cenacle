// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { setServerLanguage } from '../meetings/data';
import { myProfileQuery } from '../profile/profiles';
import { notificationsQuery } from './notifications';
import { renewPush } from './push';

/**
 * Keeps what incoming messages are checked against loaded (settings, time
 * zone), and tells the server the app's language.
 */
export function NotificationsSync() {
  const settings = useQuery(notificationsQuery);
  useQuery(myProfileQuery);
  const renew = Boolean(settings.data?.prefs.push && settings.data.push_public_key);
  // Push subscriptions end with the session that made them; this one renews them.
  useEffect(() => {
    if (renew) void renewPush();
  }, [renew]);
  // The server writes e-mails (meeting invitations) in the app's language.
  const language = useTranslation().i18n.language?.startsWith('tr') ? 'tr' : 'en';
  useEffect(() => {
    void setServerLanguage(language).catch(() => undefined);
  }, [language]);
  return null;
}
