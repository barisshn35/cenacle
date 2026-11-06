// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircleIcon,
  BellRingIcon,
  CheckCircle2Icon,
  CircleCheckBigIcon,
  FlagIcon,
  InfoIcon,
  XIcon,
} from 'lucide-react';
import { useId, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@cenacle/ui/components/popover';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from './active-workspace';
import { ackMessage, applyAck, type Channel, type Message } from './data';
import type { Priority } from './pending';

/**
 * The composer's priority menu: standard, important or urgent; asking readers
 * to acknowledge; reminding the people mentioned (urgent messages, where the
 * workspace allows it).
 */
export function PriorityMenu({
  value,
  onChange,
  open,
  onOpenChange,
  anchor,
}: {
  value: Priority;
  onChange: (value: Priority) => void;
  /** Opened from another control (the composer's "+" menu), next to `anchor`, without its own button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchor?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { workspace } = useActiveWorkspace();
  const canRemind = workspace?.persistent_notifications !== false;
  const set = (patch: Partial<Priority>) => {
    const next = { ...value, ...patch };
    // Reminders are for urgent messages only.
    if (next.level !== 'urgent') next.persistent = false;
    onChange(next);
  };
  const levels = [
    { key: undefined, label: t('priority.standard') },
    { key: 'important' as const, label: t('priority.important') },
    { key: 'urgent' as const, label: t('priority.urgent') },
  ];
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {!anchor && (
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('priority.open')}
              data-active={value.level || value.requestAck ? true : undefined}
              className="data-[active]:text-primary"
            />
          }
        >
          <FlagIcon strokeWidth={1.75} />
        </PopoverTrigger>
      )}
      <PopoverContent side="top" align="end" className="w-72" anchor={anchor} finalFocus={anchor}>
        <PopoverTitle className="mb-2 text-sm font-semibold">{t('priority.title')}</PopoverTitle>
        <fieldset className="grid gap-1">
          <legend className="sr-only">{t('priority.title')}</legend>
          {levels.map((l) => (
            <div key={l.label} className="flex min-h-target items-center gap-2 text-sm">
              <input
                id={`${id}-${l.key ?? 'standard'}`}
                type="radio"
                name={`${id}-level`}
                className="size-4 accent-primary"
                checked={value.level === l.key}
                onChange={() => set({ level: l.key })}
              />
              <label htmlFor={`${id}-${l.key ?? 'standard'}`}>{l.label}</label>
            </div>
          ))}
        </fieldset>
        <div className="mt-2 grid gap-1 border-t pt-2">
          <div className="flex min-h-target items-center gap-2 text-sm">
            <input
              id={`${id}-ack`}
              type="checkbox"
              className="size-4 accent-primary"
              checked={!!value.requestAck}
              onChange={(e) => set({ requestAck: e.target.checked })}
            />
            <label htmlFor={`${id}-ack`}>{t('priority.requestAck')}</label>
          </div>
          {canRemind && (
            <div className="flex min-h-target items-start gap-2 text-sm">
              <input
                id={`${id}-persistent`}
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                disabled={value.level !== 'urgent'}
                checked={!!value.persistent}
                aria-describedby={`${id}-persistent-hint`}
                onChange={(e) => set({ persistent: e.target.checked })}
              />
              <div>
                <label htmlFor={`${id}-persistent`}>{t('priority.persistent')}</label>
                <p id={`${id}-persistent-hint`} className="text-xs text-muted-foreground">
                  {t('priority.persistentHint', {
                    minutes: workspace?.persistent_every_minutes ?? 5,
                    times: workspace?.persistent_times ?? 6,
                  })}
                </p>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** What was chosen, above the text, with a way to clear it. */
export function PriorityChip({ value, onClear }: { value: Priority; onClear: () => void }) {
  const { t } = useTranslation();
  if (!value.level && !value.requestAck) return null;
  const parts = [
    value.level === 'urgent'
      ? t('priority.urgent')
      : value.level === 'important'
        ? t('priority.important')
        : null,
    value.requestAck ? t('priority.requestAck') : null,
    value.persistent ? t('priority.persistent') : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1 text-xs" data-testid="priority-chip">
      <PriorityIcon level={value.level} />
      <span className="font-medium">{parts.join(' · ')}</span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t('priority.clear')}
        onClick={onClear}
      >
        <XIcon strokeWidth={1.75} />
      </Button>
    </div>
  );
}

function PriorityIcon({ level }: { level?: Priority['level'] }) {
  if (level === 'urgent') {
    return <AlertCircleIcon aria-hidden className="size-3.5 text-warning" strokeWidth={1.75} />;
  }
  if (level === 'important') {
    return <InfoIcon aria-hidden className="size-3.5 text-info" strokeWidth={1.75} />;
  }
  return <CheckCircle2Icon aria-hidden className="size-3.5" strokeWidth={1.75} />;
}

/** "Important" or "Urgent" above a message, with a note when it reminds people. */
export function PriorityLabel({ message }: { message: Message }) {
  const { t } = useTranslation();
  if (!message.priority) return null;
  const urgent = message.priority === 'urgent';
  return (
    <p
      className={cn(
        'mb-0.5 flex items-center gap-1 text-xs font-semibold',
        urgent ? 'text-warning' : 'text-info',
      )}
      data-testid="priority"
    >
      <PriorityIcon level={message.priority} />
      {urgent ? t('priority.urgent') : t('priority.important')}
      {message.persistent && (
        <span className="flex items-center gap-1 font-normal text-muted-foreground">
          <BellRingIcon aria-hidden className="size-3" strokeWidth={1.75} />
          {t('priority.reminding')}
        </span>
      )}
    </p>
  );
}

/** Acknowledging a message that asks for it, and who has. */
export function AckBar({ message, channel }: { message: Message; channel: Channel }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const { user } = useSession();
  const queryClient = useQueryClient();
  const ack = useMutation({
    mutationFn: (acked: boolean) => ackMessage(message, acked),
    onMutate: (acked) =>
      applyAck(
        queryClient,
        {
          channel_id: message.channel_id,
          message_id: message.id,
          user_id: self,
          display_name: user.display_name || user.email,
          acked,
        },
        self,
      ),
    onError: (_err, acked) => {
      applyAck(
        queryClient,
        {
          channel_id: message.channel_id,
          message_id: message.id,
          user_id: self,
          display_name: user.display_name || user.email,
          acked: !acked,
        },
        self,
      );
      toast.error(t('priority.ackFailed'));
    },
  });
  if (!message.ack) return null;
  const names = message.ack.people.map((p) => p.display_name);
  const own = message.author.id === self;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid="ack">
      {!own && !channel.archived && (
        <Button
          size="sm"
          variant={message.ack.me ? 'secondary' : 'outline'}
          aria-pressed={message.ack.me}
          onClick={() => ack.mutate(!message.ack!.me)}
        >
          <CircleCheckBigIcon aria-hidden strokeWidth={1.75} />
          {message.ack.me ? t('priority.acked') : t('priority.ack')}
        </Button>
      )}
      <span className="text-muted-foreground" title={names.join(', ')}>
        {message.ack.count === 0
          ? t('priority.noAcks')
          : t('priority.acks', { count: message.ack.count, names: names.slice(0, 3).join(', ') })}
      </span>
    </div>
  );
}
