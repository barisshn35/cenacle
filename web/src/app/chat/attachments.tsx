// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from '@cenacle/ui/lib/utils';
import { CardActions } from './interactions';
import type { components } from '@cenacle/core/api';
import { MessageBody } from './markdown/message-body';

type Attachment = components['schemas']['Attachment'];

const STRIPE: Record<NonNullable<Attachment['color']>, string> = {
  neutral: 'border-l-attachment-stripe-default',
  info: 'border-l-attachment-stripe-info',
  success: 'border-l-attachment-stripe-success',
  warning: 'border-l-attachment-stripe-warning',
  danger: 'border-l-attachment-stripe-danger',
};

/**
 * Cards under a message (issues, alerts from bots). The stripe color only
 * repeats what the card says: meaning is never in the color alone.
 */
export function Attachments({
  items,
  selfId,
  message,
}: {
  items: Attachment[];
  selfId: string;
  /** The message the cards are in: their buttons and menus work there only. */
  message?: { id: string; channel_id: string };
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1 flex max-w-xl flex-col gap-1.5">
      {items.map((a, i) => (
        <article
          key={i}
          data-testid="attachment"
          className={cn(
            'rounded-md border border-l-4 bg-card px-3 py-2 text-sm',
            STRIPE[a.color ?? 'neutral'],
          )}
        >
          {a.title &&
            (a.title_link ? (
              <a
                href={a.title_link}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
                className="font-semibold text-accent-brand underline-offset-2 hover:underline"
                data-target-exempt
              >
                {a.title}
              </a>
            ) : (
              <p className="font-semibold">{a.title}</p>
            ))}
          {a.text && <MessageBody body={a.text} mentions={[]} selfId={selfId} />}
          {a.fields && a.fields.length > 0 && (
            <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
              {a.fields.map((f, j) => (
                <div key={j} className={f.short ? 'col-span-1' : 'col-span-2'}>
                  <dt className="text-xs font-medium text-muted-foreground">{f.title}</dt>
                  <dd className="whitespace-pre-wrap">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {a.footer && <p className="mt-1 text-xs text-muted-foreground">{a.footer}</p>}
          {message && a.actions && a.actions.length > 0 && (
            <CardActions message={message} index={i} actions={a.actions} />
          )}
        </article>
      ))}
    </div>
  );
}
