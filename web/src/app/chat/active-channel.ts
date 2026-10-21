// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { channelsQuery, type Channel } from './data';

/** The channel of the current URL (/c/<id>), once the channel list has loaded. */
export function useActiveChannel(): { id: string | undefined; channel: Channel | undefined } {
  const { channelId } = useParams({ strict: false });
  const channels = useQuery(channelsQuery);
  return { id: channelId, channel: channels.data?.find((c) => c.id === channelId) };
}
