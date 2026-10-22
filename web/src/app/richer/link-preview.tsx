// SPDX-License-Identifier: AGPL-3.0-only
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { useSession } from '../auth/session';
import type { Message } from '../chat/data';
import { hideLinkPreview } from './richer';

/**
 * The preview of a message's first link: the page's title, description and
 * image (fetched and served by Cenacle, so the site never sees the reader).
 * Its author can remove it.
 */
export function LinkPreviewCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const p = message.link_preview;
  if (!p) return null;
  const host = (() => {
    try {
      return new URL(p.url).hostname;
    } catch {
      return p.url;
    }
  })();
  return (
    <div
      data-testid="link-preview"
      className="relative mt-1 flex max-w-lg gap-3 overflow-hidden rounded-lg border border-l-3 border-l-muted-foreground/40 bg-card p-3 text-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{p.site_name || host}</p>
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="line-clamp-2 font-semibold hover:underline"
          data-target-exempt
        >
          {p.title || host}
        </a>
        {p.description && (
          <p className="mt-0.5 line-clamp-3 text-muted-foreground">{p.description}</p>
        )}
      </div>
      {p.image_url && (
        <img
          src={p.image_url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-20 shrink-0 self-center rounded-md border object-cover"
        />
      )}
      {message.author.id === self && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="absolute top-1 right-1"
          aria-label={t('richer.preview.remove')}
          onClick={() => {
            hideLinkPreview(message).catch(() => toast.error(t('richer.preview.failed')));
          }}
        >
          <XIcon strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}
