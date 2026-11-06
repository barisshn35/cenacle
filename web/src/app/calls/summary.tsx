// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { PhoneIcon } from 'lucide-react';
import { calls } from '@cenacle/core';

import { useProfile } from '../profile/profiles';
import type { Summary } from './summary-data';

const SHOWN = 4;

export function CallSummaryCard({ summary }: { summary: Summary }) {
  const { t, i18n } = useTranslation('calls');
  const minutes = Math.floor(summary.duration_seconds / 60);
  const seconds = String(Math.floor(summary.duration_seconds % 60)).padStart(2, '0');
  // Who took part comes from the call record, which follows erasure and retention:
  // the message itself holds no names. A purged or hidden call shows the count only.
  const call = useQuery({
    queryKey: ['calls', 'summary', summary.call_id],
    queryFn: ({ signal }) => calls.get(summary.call_id!, signal),
    enabled: summary.outcome === 'ended' && !!summary.call_id,
    staleTime: Infinity,
    retry: false,
  }).data;
  const joined = [
    ...new Set(
      (call?.participants ?? [])
        .filter((p) => p.joined_at && p.user_id)
        .map((p) => p.user_id as string),
    ),
  ];
  const started = call?.started_at
    ? new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(call.started_at),
      )
    : '';
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="call-summary">
      <PhoneIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>{t(`summary_${summary.outcome}`)}</span>
      {summary.outcome === 'ended' && (
        <span className="text-muted-foreground">
          {started && <>{t('summaryStarted', { time: started })} · </>}
          {minutes}:{seconds} ·{' '}
          {joined.length ? (
            <People ids={joined} />
          ) : (
            t('participants', { count: summary.participants })
          )}
        </span>
      )}
    </div>
  );
}

function People({ ids }: { ids: string[] }) {
  const { t, i18n } = useTranslation('calls');
  const names = ids.slice(0, SHOWN).map((id) => <Name key={id} id={id} />);
  const more = ids.length - SHOWN;
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' });
  // Interleave the names with the language's own separators.
  const parts = list.formatToParts([
    ...names.map((_, i) => `\u0000${i}`),
    ...(more > 0 ? [t('summaryMore', { count: more })] : []),
  ]);
  return (
    <>
      {parts.map((part, i) =>
        part.type === 'element' && part.value.startsWith('\u0000') ? (
          <span key={i}>{names[Number(part.value.slice(1))]}</span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}

function Name({ id }: { id: string }) {
  const { t } = useTranslation('calls');
  return <>{useProfile(id)?.display_name ?? t('participant')}</>;
}
