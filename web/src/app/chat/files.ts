// SPDX-License-Identifier: AGPL-3.0-only
import { infiniteQueryOptions } from '@tanstack/react-query';
import { ApiError, apiFetch, NETWORK_ERROR, type components } from '@cenacle/core/api';
import { isMLS } from '../e2e/channels';
import { encryptFile, fileKeys } from '../e2e/files';

export type FileInfo = components['schemas']['FileInfo'];
export type ChannelFile = components['schemas']['ChannelFile'];

export const fileUrl = (id: string, download = false) =>
  `/api/files/${id}/content${download ? '?download=true' : ''}`;
export const thumbnailUrl = (id: string) => `/api/files/${id}/thumbnail`;

export const isImage = (f: Pick<FileInfo, 'content_type'>) =>
  /^image\/(jpeg|png|gif|webp)$/.test(f.content_type);

/** "1.2 MB"-style sizes, in the reader's language. */
export function formatSize(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let i = 0;
  let n = bytes;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[i],
    unitDisplay: 'short',
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(n);
}

interface UploadStart {
  file: FileInfo;
  upload: { url: string; fields: Record<string, string> };
}

/** What the app recorded: a voice message (with its waveform) or a clip. */
export interface Recording {
  media_kind: 'voice' | 'clip';
  duration_ms: number;
  waveform?: number[];
}

/** Recordings made in the app, by their file (sent with the upload). */
export const recordings = new WeakMap<File, Recording>();

/**
 * Uploads a file into a channel: the server issues a form, the browser posts
 * the bytes straight to the object store, and the server checks the result.
 * Calls onProgress with 0–1. Abort with the signal.
 */
export async function uploadFile(
  channelId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
  onCreated?: (id: string) => void,
): Promise<FileInfo> {
  // Channels encrypted with device keys get the file encrypted here.
  const sealed = isMLS(channelId) ? await encryptFile(file) : null;
  const bytes = sealed?.blob ?? file;
  const start = await apiFetch<UploadStart>(`/api/channels/${channelId}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      sealed
        ? { name: 'encrypted', size: bytes.size, encrypted: true }
        : {
            name: file.name,
            size: file.size,
            content_type: file.type || 'application/octet-stream',
            ...recordings.get(file),
          },
    ),
    signal,
  });
  onCreated?.(start.file.id);
  await new Promise<void>((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(start.upload.fields)) form.append(k, v);
    form.append('file', bytes);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', start.upload.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(
            new ApiError({
              type: 'about:blank',
              title: 'Upload failed',
              status: xhr.status,
              code: 'upload_failed',
            }),
          );
    xhr.onerror = () =>
      reject(
        new ApiError({
          type: 'about:blank',
          title: 'Network error',
          status: 0,
          code: NETWORK_ERROR,
        }),
      );
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
  const done = await apiFetch<FileInfo>(`/api/files/${start.file.id}/complete`, {
    method: 'POST',
    signal,
  });
  if (!sealed) return done;
  const type = file.type || 'application/octet-stream';
  fileKeys.set(done.id, {
    id: done.id,
    k: sealed.k,
    iv: sealed.iv,
    name: file.name,
    type,
    size: file.size,
  });
  // The composer shows the file as it is, not as the server keeps it.
  return { ...done, name: file.name, content_type: type, size: file.size };
}

export const deleteUpload = (id: string) =>
  apiFetch<void>(`/api/files/${id}`, { method: 'DELETE' });

export const channelFilesQuery = (channelId: string) =>
  infiniteQueryOptions({
    queryKey: ['files', channelId],
    queryFn: ({ pageParam }) =>
      apiFetch<{ files: ChannelFile[]; has_more: boolean }>(
        `/api/channels/${channelId}/files${pageParam ? `?before=${pageParam}` : ''}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? page.files.at(-1)?.id : undefined),
  });
