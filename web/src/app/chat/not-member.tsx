// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { useActiveWorkspace } from './active-workspace';
import { directoryQuery, joinChannel, reloadChannels } from './data';

/** A channel the user is not a member of: offer to join, or say it is gone. */
export function NotMember({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { id: workspaceId } = useActiveWorkspace();
  const directory = useQuery(directoryQuery(workspaceId));
  const queryClient = useQueryClient();
  const join = useMutation({
    mutationFn: () => joinChannel(channelId),
    onSuccess: () => reloadChannels(queryClient),
  });
  if (directory.isPending) return <div className="flex-1" />;
  const channel = directory.data?.find((c) => c.id === channelId);
  return (
    <div
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      {channel ? (
        <>
          <p className="font-display text-2xl font-medium">{channel.name}</p>
          <p className="text-muted-foreground">{t('channels.notMember')}</p>
          <Button onClick={() => join.mutate()} disabled={join.isPending}>
            {t('channels.joinNamed', { channel: channel.name })}
          </Button>
        </>
      ) : (
        <p className="text-muted-foreground">{t('channels.notFound')}</p>
      )}
    </div>
  );
}
