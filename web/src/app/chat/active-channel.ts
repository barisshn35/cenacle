// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useLastWorkspace } from './active-workspace';
import { channelsQuery, directoryQuery, type Channel } from './data';

/**
 * The channel of the current URL (/c/<id>), once the channel list has loaded.
 * Archived channels are not in the sidebar list; their members find them in
 * the directory.
 */
export function useActiveChannel(): { id: string | undefined; channel: Channel | undefined } {
  const { channelId } = useParams({ strict: false });
  const channels = useQuery(channelsQuery);
  const listed = channels.data?.find((c) => c.id === channelId);
  const lastWorkspace = useLastWorkspace((s) => s.id) ?? undefined;
  const directoryOptions = directoryQuery(lastWorkspace);
  const directory = useQuery({
    ...directoryOptions,
    enabled: directoryOptions.enabled !== false && channels.isSuccess && !!channelId && !listed,
  });
  const archived = directory.data?.find((c) => c.id === channelId && c.is_member && c.archived);
  return { id: channelId, channel: listed ?? archived };
}
