// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { channelsQuery } from './data';

/** "/" opens #general (or the first channel). */
export function ChannelIndex() {
  const { t } = useTranslation();
  const channels = useQuery(channelsQuery);
  if (channels.isError) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <ErrorState
          problem={channels.error instanceof ApiError ? channels.error.problem : { status: 500 }}
          actions={<Button onClick={() => void channels.refetch()}>{t('ui:errors.retry')}</Button>}
        />
      </main>
    );
  }
  const list = channels.data;
  if (!list) return null;
  const target = list.find((c) => c.name === 'general') ?? list[0];
  if (!target) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <p className="text-muted-foreground">{t('chat.noChannels')}</p>
      </main>
    );
  }
  return <Navigate to="/c/$channelId" params={{ channelId: target.id }} replace />;
}
