// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { PhoneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { activeCallsQuery } from './state';

/** In the sidebar: a call is going on here, and how many are in it. */
export function CallMark({ channelId, workspaceId }: { channelId: string; workspaceId: string }) {
  const { t } = useTranslation('calls');
  const call = useQuery(activeCallsQuery(workspaceId)).data?.find(
    (c) => c.channel_id === channelId && c.state !== 'ended',
  );
  if (!call) return null;
  const count = call.participants.filter((p) => p.state !== 'left').length;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-sidebar-accent px-1.5 text-[11px] font-semibold text-sidebar-accent-foreground tabular-nums"
      data-testid="call-mark"
    >
      <PhoneIcon aria-hidden className="size-3" strokeWidth={2} />
      {count > 0 && <span aria-hidden>{count}</span>}
      <span className="sr-only">{t('inProgress', { count })}</span>
    </span>
  );
}
