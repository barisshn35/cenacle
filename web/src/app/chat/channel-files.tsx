// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import { Skeleton } from '@cenacle/ui/components/skeleton';
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

/** The files shared in a channel, newest first (details panel). */
export function ChannelFiles({ channelId }: { channelId: string }) {
  const { t, i18n } = useTranslation();
  const files = useInfiniteQuery(channelFilesQuery(channelId));
  const [open, setOpen] = useState<number | null>(null);
  const list: ChannelFile[] = files.data?.pages.flatMap((p) => p.files) ?? [];
  const images = list.filter(isImage);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  return (
    <section aria-labelledby="channel-files-title" className="flex flex-col gap-2">
      <h3 id="channel-files-title" className="text-xs font-medium text-muted-foreground uppercase">
        {t('files.title')}
      </h3>
      {files.isPending ? (
        <Skeleton className="h-10" />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('files.none')}</p>
      ) : (
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
