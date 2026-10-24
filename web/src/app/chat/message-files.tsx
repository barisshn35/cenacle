// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileTextIcon,
  FileVideoIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '@cenacle/ui/components/button';
import { fileUrl, formatSize, isImage, thumbnailUrl, type FileInfo } from './files';
import { Lightbox } from './lightbox';
import { ClipPlayer, VoicePlayer } from '../richer/voice';

export function FileTypeIcon({
  file,
  className,
}: {
  file: Pick<FileInfo, 'content_type' | 'name'>;
  className?: string;
}) {
  const t = file.content_type;
  const Icon = t.startsWith('video/')
    ? FileVideoIcon
    : t.startsWith('audio/')
      ? FileAudioIcon
      : t.startsWith('text/') || t === 'application/pdf'
        ? FileTextIcon
        : /\.(zip|tar|gz|7z|rar)$/i.test(file.name)
          ? FileArchiveIcon
          : FileIcon;
  return <Icon aria-hidden strokeWidth={1.75} className={className} />;
}

/** A file that is not an image: its name, size and a download link. */
export function FileCard({ file }: { file: FileInfo }) {
  const { t, i18n } = useTranslation();
  return (
    <div
      data-testid="file"
      className="flex w-full max-w-sm items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm"
    >
      <FileTypeIcon file={file} className="size-6 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <a
          href={fileUrl(file.id)}
          target="_blank"
          rel="noopener"
          className="flex min-h-target items-center font-medium hover:underline"
        >
          <span className="truncate">{file.name}</span>
        </a>
        <p className="text-xs text-muted-foreground">{formatSize(file.size, i18n.language)}</p>
      </div>
      <a
        href={fileUrl(file.id, true)}
        download={file.name}
        aria-label={t('files.downloadNamed', { name: file.name })}
        className={buttonVariants({ size: 'icon-sm', variant: 'ghost' })}
      >
        <DownloadIcon aria-hidden strokeWidth={1.75} />
      </a>
    </div>
  );
}

/** The files of a message: images as previews (opened in the viewer), others as cards. */
export function MessageFiles({ files }: { files: FileInfo[] | undefined }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  if (!files?.length) return null;
  const media = files.filter((f) => f.media_kind);
  const images = files.filter((f) => isImage(f) && !f.media_kind);
  const others = files.filter((f) => !isImage(f) && !f.media_kind);
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {media.map((f) =>
        f.media_kind === 'voice' ? (
          <VoicePlayer key={f.id} file={f} />
        ) : (
          <ClipPlayer key={f.id} file={f} />
        ),
      )}
      {images.length === 1 && (
        <ul className="flex" aria-label={t('files.images')}>
          {images.map((f) => {
            // A single preview keeps the image's shape within 320×240.
            const ratio = f.width && f.height ? f.width / f.height : 4 / 3;
            const h = Math.min(240, 320 / ratio);
            return (
              <li key={f.id}>
                <ImageTile
                  file={f}
                  onOpen={() => setOpen(0)}
                  style={{ height: h, width: h * ratio }}
                />
              </li>
            );
          })}
        </ul>
      )}
      {images.length > 1 && <Gallery images={images} onOpen={setOpen} />}
      {others.map((f) => (
        <FileCard key={f.id} file={f} />
      ))}
      <Lightbox images={images} index={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function ImageTile({
  file,
  onOpen,
  style,
  className,
  more,
}: {
  file: FileInfo;
  onOpen: () => void;
  style?: React.CSSProperties;
  className?: string;
  /** Images not shown, counted on the last tile. */
  more?: number;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-testid="image"
      aria-label={
        more
          ? t('files.openMore', { name: file.name, count: more })
          : t('files.openImage', { name: file.name })
      }
      onClick={onOpen}
      className={`relative block overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${className ?? ''}`}
      style={style}
    >
      <img
        src={file.has_thumbnail ? thumbnailUrl(file.id) : fileUrl(file.id)}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover motion-safe:transition-opacity"
      />
      {!!more && (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center bg-foreground/55 text-xl font-semibold text-background"
        >
          +{more}
        </span>
      )}
    </button>
  );
}

/**
 * Several images as one gallery (v0.32): two side by side, three with the
 * first larger, four or more in a square of four, the last one counting the
 * rest. Each opens the viewer at itself.
 */
function Gallery({ images, onOpen }: { images: FileInfo[]; onOpen: (i: number) => void }) {
  const { t } = useTranslation();
  const shown = images.slice(0, 4);
  const more = images.length - shown.length;
  return (
    <ul
      aria-label={t('files.gallery', { count: images.length })}
      data-testid="gallery"
      className="grid w-full max-w-[480px] auto-rows-[150px] grid-cols-2 gap-1 sm:auto-rows-[180px]"
    >
      {shown.map((f, i) => (
        <li key={f.id} className={images.length === 3 && i === 0 ? 'row-span-2' : undefined}>
          <ImageTile
            file={f}
            className="size-full"
            onOpen={() => onOpen(i)}
            more={i === shown.length - 1 && more > 0 ? more : undefined}
          />
        </li>
      ))}
    </ul>
  );
}
