// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { ShieldIcon } from 'lucide-react';
import { cn } from '@cenacle/ui/lib/utils';
import type { Channel } from '../chat/data';
import { classificationsQuery, type Classification } from './compliance';

/** Stripe and text colors of a classification (its name says the meaning too). */
const TONES: Record<Classification['color'], string> = {
  neutral: 'border-border bg-muted text-foreground',
  info: 'border-[var(--attachment-stripe-info)] bg-[color-mix(in_oklch,var(--attachment-stripe-info)_12%,transparent)]',
  success:
    'border-[var(--attachment-stripe-success)] bg-[color-mix(in_oklch,var(--attachment-stripe-success)_12%,transparent)]',
  warning:
    'border-[var(--attachment-stripe-warning)] bg-[color-mix(in_oklch,var(--attachment-stripe-warning)_14%,transparent)]',
  danger:
    'border-[var(--attachment-stripe-danger)] bg-[color-mix(in_oklch,var(--attachment-stripe-danger)_12%,transparent)]',
};

/** The classification banner of a channel: its own, else the workspace's default. */
export function ClassificationBanner({ channel }: { channel: Channel }) {
  const data = useQuery(classificationsQuery(channel.workspace_id)).data;
  const id = channel.classification_id ?? data?.default_id;
  const c = id ? data?.classifications.find((x) => x.id === id) : undefined;
  if (!c) return null;
  return (
    <p
      data-testid="classification"
      className={cn(
        'flex shrink-0 items-center gap-2 border-y border-l-4 px-4 py-1 text-xs',
        TONES[c.color],
      )}
    >
      <ShieldIcon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="font-semibold">{c.name}</span>
      {c.description && <span className="text-foreground/80">{c.description}</span>}
    </p>
  );
}
