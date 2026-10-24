// SPDX-License-Identifier: AGPL-3.0-only
import { FileIcon, RotateCwIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { cn } from '@cenacle/ui/lib/utils';
import { formatSize } from './files';
import type { useUploads } from './use-uploads';

/** The upload list above the text. */
export function UploadList({
  uploads,
}: {
  uploads: Pick<ReturnType<typeof useUploads>, 'items' | 'remove' | 'retry'>;
}) {
  const { t, i18n } = useTranslation();
  if (uploads.items.length === 0) return null;
  return (
    <ul aria-label={t('files.attached')} className="flex flex-wrap gap-2 pt-1.5 pb-1">
      {uploads.items.map((u) => (
        <li
          key={u.key}
          data-testid="upload"
          className={cn(
            'relative flex w-56 items-center gap-2 overflow-hidden rounded-lg border bg-background py-1 pe-1 ps-2 text-sm',
            u.status === 'failed' && 'border-destructive/60',
          )}
        >
          <FileIcon
            aria-hidden
            strokeWidth={1.75}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate">{u.file.name}</p>
            <p
              className={cn(
                'truncate text-xs',
                u.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {u.status === 'failed'
                ? t(`files.error.${u.error ?? 'failed'}`, { defaultValue: t('files.error.failed') })
                : u.status === 'uploading'
                  ? t('files.uploading', { percent: Math.round(u.progress * 100) })
                  : formatSize(u.file.size, i18n.language)}
            </p>
          </div>
          {u.status === 'failed' && u.error !== 'file_too_large' && u.error !== 'file_blocked' && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('files.retryNamed', { name: u.file.name })}
              onClick={() => uploads.retry(u.key)}
            >
              <RotateCwIcon strokeWidth={1.75} />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('files.removeNamed', { name: u.file.name })}
            onClick={() => uploads.remove(u.key)}
          >
            <XIcon strokeWidth={1.75} />
          </Button>
          {u.status === 'uploading' && (
            <div
              role="progressbar"
              aria-label={t('files.progressNamed', { name: u.file.name })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(u.progress * 100)}
              className="absolute inset-x-0 bottom-0 h-0.5 bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${u.progress * 100}%` }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
