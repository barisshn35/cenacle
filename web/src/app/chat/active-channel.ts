// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
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
  const directory = useQuery({
    ...directoryQuery,
    enabled: channels.isSuccess && !!channelId && !listed,
  });
  const archived = directory.data?.find((c) => c.id === channelId && c.is_member && c.archived);
  return { id: channelId, channel: listed ?? archived };
}
