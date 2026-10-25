// SPDX-License-Identifier: AGPL-3.0-only
import { PencilIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { ChannelIcon } from '../chat/channel-icon';
import { ChannelSettingsDialog } from '../chat/channel-settings';
import { membersQuery, type Channel } from '../chat/data';
import { useActiveWorkspace } from '../chat/active-workspace';
import { ChannelComplianceDialog } from '../compliance/channel-compliance';
import { classificationsQuery } from '../compliance/compliance';
import { usePeriodLabel } from '../compliance/retention-label';
import { pinsQuery } from '../threads/threads';
import { dateLocale } from '../../i18n/time-format';

/** When a UUIDv7 was made: its first 48 bits are milliseconds since the epoch. */
function createdAt(id: string): Date | null {
  const hex = id.replace(/-/g, '').slice(0, 12);
  const ms = Number.parseInt(hex, 16);
  return id[14] === '7' && Number.isFinite(ms) ? new Date(ms) : null;
}

function Cell({
  label,
  children,
  edit,
  className,
}: {
  label: string;
  children: ReactNode;
  /** Shown only on the cells the reader may change. */
  edit?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div className={cn('relative min-w-0 px-3 pt-2 pb-2.5', className)}>
      <dt className="text-[11.5px] leading-4 text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] leading-[18px]">{children}</dd>
      {edit && (
        <button
          type="button"
          aria-label={edit.label}
          onClick={edit.onClick}
          className="hit-target absolute top-1/2 end-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <PencilIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

/**
 * The title block of a channel: its governance stated as cells (owner,
 * members, classification, retention, created, pinned), like the title block
 * of a drawing. Only the cells the reader may change carry a pencil.
 */
export function TitleBlock({ channel }: { channel: Channel }) {
  const { t, i18n } = useTranslation();
  const { admin } = useActiveWorkspace();
  const period = usePeriodLabel();
  const members = useQuery(membersQuery(channel.id)).data;
  const pins = useQuery(pinsQuery(channel.id)).data;
  const classes = useQuery(classificationsQuery(channel.workspace_id)).data;
  const [dialog, setDialog] = useState<'settings' | 'compliance' | null>(null);

  const classId = channel.classification_id ?? classes?.default_id;
  const classification = classId ? classes?.classifications.find((c) => c.id === classId) : null;
  const managers = (members ?? []).filter((m) => m.role === 'manager');
  const created = createdAt(channel.id);
  const compliance = (label: string) =>
    admin ? { label, onClick: () => setDialog('compliance') } : undefined;

  return (
    <>
      <dl
        aria-label={t('channels.titleBlock.channel')}
        className="grid grid-cols-2 overflow-hidden rounded-[10px] border border-rule-strong bg-background [&>div]:border-border [&>div:nth-child(n+2)]:border-t [&>div:nth-child(2n+1):not(:first-child)]:border-s"
      >
        <Cell
          label={t('channels.titleBlock.channel')}
          className="col-span-2 pb-3"
          edit={
            channel.can_manage
              ? {
                  label: t('channels.settings'),
                  onClick: () => setDialog('settings'),
                }
              : undefined
          }
        >
          <span className="flex items-center gap-2 pe-6 text-[22px] leading-7 font-semibold tracking-[-0.01em]">
            <ChannelIcon channel={channel} className="size-4 shrink-0" />
            <span className="truncate">{channel.name}</span>
          </span>
        </Cell>
        <Cell label={t('channels.titleBlock.owner')}>
          <span className="line-clamp-2 break-words">
            {managers.length > 0
              ? managers.map((m) => m.user.display_name).join(', ')
              : t('channels.titleBlock.noOwner')}
          </span>
        </Cell>
        <Cell label={t('channels.titleBlock.members')}>
          <span className="font-mono tabular-nums">{members ? members.length : '…'}</span>
        </Cell>
        <Cell
          label={t('channels.titleBlock.classification')}
          edit={compliance(t('channels.titleBlock.editClassification'))}
        >
          {classification ? (
            <span className="rounded-[4px] bg-muted px-1.5 py-0.5 font-medium">
              {classification.name}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('channels.titleBlock.none')}</span>
          )}
        </Cell>
        <Cell
          label={t('channels.titleBlock.retention')}
          edit={compliance(t('channels.titleBlock.editRetention'))}
        >
          {channel.retention_days
            ? period(channel.retention_days)
            : t('channels.titleBlock.workspaceRetention')}
        </Cell>
        <Cell label={t('channels.titleBlock.created')}>
          <span className="font-mono text-[13px] tabular-nums">
            {created
              ? new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' }).format(
                  created,
                )
              : '—'}
          </span>
        </Cell>
        <Cell label={t('channels.titleBlock.pinned')}>
          <span className="font-mono tabular-nums">{pins ? pins.length : '…'}</span>
        </Cell>
        {channel.retention_days ? (
          <div className="col-span-2 px-3 py-2.5 text-[12.5px] leading-[18px] text-muted-foreground">
            {t('channels.titleBlock.retentionNote', { period: period(channel.retention_days) })}
          </div>
        ) : null}
      </dl>
      {dialog === 'settings' && (
        <ChannelSettingsDialog channel={channel} open onOpenChange={() => setDialog(null)} />
      )}
      {dialog === 'compliance' && (
        <ChannelComplianceDialog channel={channel} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
