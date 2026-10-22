// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CustomStatusDialog } from './custom-status-dialog';
import { useProfileDialogs } from './dialogs-state';
import { EditProfileDialog } from './edit-profile-dialog';
import { browserTimeZone, myProfileQuery, saved, updateMyProfile } from './profiles';

/**
 * The profile dialogs (opened from the card, the status menu and settings),
 * mounted with the profile loaded so their forms start from it. It also tells
 * the server the browser's time zone the first time (for "local time").
 */
export function ProfileDialogs() {
  const dialog = useProfileDialogs((s) => s.dialog);
  const close = useProfileDialogs((s) => s.close);
  const me = useQuery(myProfileQuery);
  const queryClient = useQueryClient();
  const { mutate: reportZone, isIdle } = useMutation({
    mutationFn: (timezone: string) => updateMyProfile({ timezone }),
    onSuccess: (profile) => saved(queryClient, profile),
  });
  const known = me.data?.timezone;
  useEffect(() => {
    const here = browserTimeZone();
    if (me.data && known === '' && here && isIdle) reportZone(here);
  }, [me.data, known, isIdle, reportZone]);

  if (!me.data) return null;
  const onOpenChange = (open: boolean) => {
    if (!open) close();
  };
  return (
    <>
      {dialog === 'edit' && <EditProfileDialog open onOpenChange={onOpenChange} />}
      {dialog === 'status' && <CustomStatusDialog open onOpenChange={onOpenChange} />}
    </>
  );
}
