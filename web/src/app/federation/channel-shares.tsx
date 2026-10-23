// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { useActiveWorkspace } from '../chat/active-workspace';
import { isConversation, type Channel } from '../chat/data';
import { federationQuery, shareChannel, sharesQuery, unshareChannel } from './federation';

/** In a channel's details: the servers it is shared with, and sharing it (admins). */
export function ChannelShares({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const id = useId();
  const { admin } = useActiveWorkspace();
  const queryClient = useQueryClient();
  const shares = useQuery(sharesQuery(channel.id)).data ?? [];
  const conns = useQuery({ ...federationQuery(channel.workspace_id), enabled: admin }).data;
  const [pick, setPick] = useState('');
  const shareable =
    admin &&
    !isConversation(channel) &&
    !channel.encrypted &&
    channel.kind !== 'forum' &&
    !channel.archived;
  const available = (conns?.connections ?? []).filter(
    (c) => c.status === 'active' && !shares.some((s) => s.connection_id === c.id),
  );
  if (shares.length === 0 && (!shareable || available.length === 0)) return null;
  const reload = () =>
    queryClient.invalidateQueries({ queryKey: sharesQuery(channel.id).queryKey });
  const failed = (err: unknown) =>
    toast.error((err instanceof ApiError && err.problem.detail) || t('federation.failed'));
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2 px-4 pt-4 text-sm"
      data-testid="shares"
    >
      <h3 id={`${id}-title`} className="flex items-center gap-1.5 text-sm font-semibold">
        <GlobeIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
        {t('federation.shares.title')}
      </h3>
      {shares.length > 0 && (
        <ul className="flex flex-col gap-1">
          {shares.map((s) => (
            <li key={s.connection_id} className="flex items-center gap-2">
              <span className="flex-1">
                {s.connection_name}
                {s.status === 'offered' && (
                  <span className="text-muted-foreground"> ({t('federation.offered')})</span>
                )}
              </span>
              {shareable && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void unshareChannel(channel.id, s.connection_id).then(reload).catch(failed)
                  }
                >
                  {t('federation.shares.stop', { server: s.connection_name })}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {shareable && available.length > 0 && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pick) return;
            void shareChannel(channel.id, pick)
              .then(() => {
                setPick('');
                toast.success(t('federation.shares.offered'));
                return reload();
              })
              .catch(failed);
          }}
        >
          <label className="flex flex-1 flex-col gap-1">
            <span>{t('federation.shares.with')}</span>
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="min-h-target rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">{t('federation.shares.choose')}</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" disabled={!pick}>
            {t('federation.shares.share')}
          </Button>
        </form>
      )}
    </section>
  );
}
