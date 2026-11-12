// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { useActiveWorkspace } from '../chat/active-workspace';
import type { Channel } from '../chat/data';
import { callSettingsQuery } from '../calls/state';
import { MeetingDialog } from './meeting-dialog';

/** In a channel's header: plan a meeting whose call happens here. */
export function PlanMeetingAction({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const settings = useQuery(callSettingsQuery(channel.workspace_id)).data;
  const { workspace } = useActiveWorkspace();
  const [open, setOpen] = useState(false);
  if (
    !settings?.available ||
    !settings.enabled ||
    channel.archived ||
    channel.encrypted ||
    channel.mls ||
    !channel.can_post ||
    workspace?.role === 'guest'
  )
    return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="max-sm:hidden"
        aria-label={t('meetings.plan')}
        onClick={() => setOpen(true)}
      >
        <CalendarPlusIcon strokeWidth={1.75} />
      </Button>
      {open && (
        <MeetingDialog
          workspaceId={channel.workspace_id}
          channel={channel}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
