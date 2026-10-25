// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { logout } from '@cenacle/core/api';
import { DraftStore } from '@cenacle/core/drafts';
import { desktop } from '../desktop/desktop';
import { forgetKeys } from '../compliance/e2e';
import { forgetThisDevice } from '../e2e/mls';
import { disablePush } from '../notifications/push';
import { useSession } from './session';

/**
 * What this device keeps for the person goes when they sign out (a shared
 * computer keeps nothing): push first and the encryption device while the
 * session still lets the server forget them, then keys, decrypted messages
 * and drafts here.
 */
async function forgetThisBrowser(userId: string) {
  await Promise.allSettled([disablePush(), forgetThisDevice(userId)]);
  await Promise.allSettled([forgetKeys(), new DraftStore().clear()]);
}

/**
 * Ends the chat session, then opens the Cenacle ID sign-out page, which ends
 * single sign-on on this device and comes back to the app.
 */
export function useSignOut() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const userId = useSession().user.id;
  return useMutation({
    // The desktop app ends the session itself and forgets its token.
    mutationFn: async () => {
      await forgetThisBrowser(userId);
      return desktop ? desktop.signOut().then(() => ({ end_session_url: '' })) : logout();
    },
    onSuccess: ({ end_session_url }) => {
      queryClient.clear();
      window.location.assign(end_session_url || '/signin');
    },
    onError: () => toast.error(t('auth.signOutFailed')),
  });
}

/** Up to two initials of a display name or e-mail address. */
export function initials(name: string): string {
  const words = name.split(/[\s@._-]+/u).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase())
    .join('');
}
