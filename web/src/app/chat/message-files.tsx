// SPDX-License-Identifier: Apache-2.0
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
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('files.images')}>
          {images.map((f, i) => {
            // Previews keep the image's shape within 320×240.
            const ratio = f.width && f.height ? f.width / f.height : 4 / 3;
            const h = Math.min(240, 320 / ratio);
            return (
              <li key={f.id}>
                <button
                  type="button"
                  data-testid="image"
                  aria-label={t('files.openImage', { name: f.name })}
                  onClick={() => setOpen(i)}
                  className="block overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <img
                    src={f.has_thumbnail ? thumbnailUrl(f.id) : fileUrl(f.id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{ height: h, width: h * ratio }}
                    className="object-cover motion-safe:transition-opacity"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {others.map((f) => (
        <FileCard key={f.id} file={f} />
      ))}
      <Lightbox images={images} index={open} onClose={() => setOpen(null)} />
    </div>
  );
}
