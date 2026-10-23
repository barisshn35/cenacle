// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { cn } from '@cenacle/ui/lib/utils';
import {
  channelFilesQuery,
  fileUrl,
  formatSize,
  isImage,
  thumbnailUrl,
  type ChannelFile,
} from './files';
import { Lightbox } from './lightbox';
import { FileTypeIcon } from './message-files';
import { dateLocale } from '../../i18n/time-format';

type Kind = 'image' | 'document' | 'media' | 'other';

/** What kind of file it is, for the filter of the files list. */
function kindOf(f: Pick<ChannelFile, 'content_type'>): Kind {
  const type = f.content_type;
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  if (
    type === 'application/pdf' ||
    type.startsWith('text/') ||
    /officedocument|msword|ms-excel|ms-powerpoint|opendocument|rtf|csv/.test(type)
  )
    return 'document';
  return 'other';
}

/** The files shared in a channel, newest first (details panel). */
export function ChannelFiles({ channelId }: { channelId: string }) {
  const { t, i18n } = useTranslation();
  const files = useInfiniteQuery(channelFilesQuery(channelId));
  const [open, setOpen] = useState<number | null>(null);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const all: ChannelFile[] = files.data?.pages.flatMap((p) => p.files) ?? [];
  const kinds = (['image', 'document', 'media', 'other'] as const).filter((k) =>
    all.some((f) => kindOf(f) === k),
  );
  const list = kind === 'all' ? all : all.filter((f) => kindOf(f) === kind);
  const images = list.filter(isImage);
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  return (
    <section aria-labelledby="channel-files-title" className="flex flex-col gap-2">
      <h3 id="channel-files-title" className="text-[13px] font-semibold text-foreground">
        {t('files.title')}
      </h3>
      {files.isPending ? (
        <Skeleton className="h-10" />
      ) : all.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('files.none')}</p>
      ) : (
        <>
          {kinds.length > 1 && (
            <div role="radiogroup" aria-label={t('files.filter')} className="flex flex-wrap gap-1">
              {(['all', ...kinds] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => setKind(k)}
                  className={cn(
                    'flex h-7 min-h-target items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    kind === k
                      ? 'border-primary bg-accent font-semibold'
                      : 'border-rule-strong text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`files.kinds.${k}`)}
                  <span className="font-mono font-normal">
                    {k === 'all' ? all.length : all.filter((f) => kindOf(f) === k).length}
                  </span>
                </button>
              ))}
            </div>
          )}
          <ul className="flex flex-col gap-1">
            {list.map((f) => (
              <li key={f.id} data-testid="channel-file" className="flex items-center gap-2 text-sm">
                {isImage(f) && f.has_thumbnail ? (
                  <button
                    type="button"
                    aria-label={t('files.openImage', { name: f.name })}
                    onClick={() => setOpen(images.findIndex((x) => x.id === f.id))}
                    className="size-9 shrink-0 overflow-hidden rounded border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <img
                      src={thumbnailUrl(f.id)}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  </button>
                ) : (
                  <FileTypeIcon file={f} className="size-9 shrink-0 p-1.5 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={fileUrl(f.id)}
                    target="_blank"
                    rel="noopener"
                    className="flex min-h-target items-center hover:underline"
                  >
                    <span className="truncate">{f.name}</span>
                  </a>
                  <p className="truncate text-xs text-muted-foreground">
                    {f.uploader.display_name} · {date.format(new Date(f.created_at))} ·{' '}
                    {formatSize(f.size, i18n.language)}
                  </p>
                </div>
                <a
                  href={fileUrl(f.id, true)}
                  download={f.name}
                  aria-label={t('files.downloadNamed', { name: f.name })}
                  className={buttonVariants({ size: 'icon-sm', variant: 'ghost' })}
                >
                  <DownloadIcon aria-hidden strokeWidth={1.75} />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {files.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={files.isFetchingNextPage}
          onClick={() => void files.fetchNextPage()}
        >
          {t('files.more')}
        </Button>
      )}
      <Lightbox images={images} index={open} onClose={() => setOpen(null)} />
    </section>
  );
}
