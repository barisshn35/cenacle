// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { fileUrl, formatSize, type FileInfo } from './files';

/**
 * Shows images full size, one at a time: arrow keys and buttons move between
 * them, Escape closes. Download is a separate, explicit action.
 */
export function Lightbox({
  images,
  index,
  onClose,
}: {
  images: FileInfo[];
  index: number | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [current, setCurrent] = useState(index ?? 0);
  const [shown, setShown] = useState(index);
  if (index !== shown) {
    setShown(index);
    if (index !== null) setCurrent(index);
  }
  const image = images[current];
  const many = images.length > 1;
  const step = (d: number) => setCurrent((c) => (c + d + images.length) % images.length);

  useEffect(() => {
    if (index === null || !many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Dialog open={index !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[95svh] w-auto flex-col gap-3 p-3 sm:max-w-[min(95vw,1400px)]">
        {image && (
          <>
            <div className="flex items-center gap-2 pe-10">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-semibold">{image.name}</DialogTitle>
                <DialogDescription className="text-xs">
                  {[
                    image.width && image.height ? `${image.width} × ${image.height}` : null,
                    formatSize(image.size, i18n.language),
                    many ? t('files.position', { n: current + 1, count: images.length }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </DialogDescription>
              </div>
              <a
                href={fileUrl(image.id, true)}
                download={image.name}
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
              >
                <DownloadIcon aria-hidden strokeWidth={1.75} />
                {t('files.download')}
              </a>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              <img
                src={fileUrl(image.id)}
                alt={image.name}
                width={image.width ?? undefined}
                height={image.height ?? undefined}
                className="max-h-[80svh] w-auto max-w-full rounded-md object-contain"
              />
              {many && (
                <>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute start-2"
                    aria-label={t('files.previous')}
                    onClick={() => step(-1)}
                  >
                    <ChevronLeftIcon strokeWidth={1.75} />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute end-2"
                    aria-label={t('files.next')}
                    onClick={() => step(1)}
                  >
                    <ChevronRightIcon strokeWidth={1.75} />
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
