// SPDX-License-Identifier: Apache-2.0
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { logout } from '@cenacle/core/api';

/**
 * Ends the chat session, then opens the Cenacle ID sign-out page, which ends
 * single sign-on on this device and comes back to the app.
 */
export function useSignOut() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
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
