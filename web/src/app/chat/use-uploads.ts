// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@cenacle/core/api';
import { deleteUpload, uploadFile, type FileInfo } from './files';

export interface Upload {
  key: string;
  file: File;
  progress: number;
  status: 'uploading' | 'ready' | 'failed';
  /** Why it failed (an error code), for the message. */
  error?: string;
  /** Set once the server knows the file (it may still be uploading). */
  id?: string;
  info?: FileInfo;
}

const MAX_FILES = 10;

/**
 * The files of the message being written: each uploads at once, shows its
 * progress, can be removed (also while uploading) and retried.
 */
export function useUploads(channelId: string, maxSize: number) {
  const [items, setItems] = useState<Upload[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const patch = (key: string, p: Partial<Upload>) =>
    setItems((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));

  const start = useCallback(
    (key: string, file: File) => {
      const ctl = new AbortController();
      controllers.current.set(key, ctl);
      void uploadFile(
        channelId,
        file,
        (progress) => patch(key, { progress }),
        ctl.signal,
        (id) => patch(key, { id }),
      )
        .then((info) => patch(key, { status: 'ready', progress: 1, info, id: info.id }))
        .catch((err: unknown) => {
          if (ctl.signal.aborted) return;
          patch(key, {
            status: 'failed',
            error: err instanceof ApiError ? err.problem.code : 'network_error',
          });
        })
        .finally(() => controllers.current.delete(key));
    },
    [channelId],
  );

  const add = (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, Math.max(0, MAX_FILES - items.length));
    const next: Upload[] = list.map((file) => ({
      key: crypto.randomUUID(),
      file,
      progress: 0,
      ...(file.size > maxSize
        ? { status: 'failed' as const, error: 'file_too_large' }
        : { status: 'uploading' as const }),
    }));
    setItems((cur) => [...cur, ...next]);
    for (const u of next) if (u.status === 'uploading') start(u.key, u.file);
    // Whether some files were left out (more than the limit).
    return files.length > list.length;
  };

  const remove = (key: string) => {
    const u = items.find((x) => x.key === key);
    controllers.current.get(key)?.abort();
    if (u?.id) void deleteUpload(u.id).catch(() => undefined);
    setItems((cur) => cur.filter((x) => x.key !== key));
  };

  const retry = (key: string) => {
    const u = items.find((x) => x.key === key);
    if (!u || u.error === 'file_too_large') return;
    patch(key, { status: 'uploading', progress: 0, error: undefined, id: undefined });
    start(key, u.file);
  };

  /** Forget the files (they were sent); nothing is deleted. */
  const clear = () => setItems([]);

  // Leaving the channel: stop uploads; unsent files are pruned by the server.
  useEffect(() => {
    const ctls = controllers.current;
    return () => ctls.forEach((c) => c.abort());
  }, []);

  return {
    items,
    add,
    remove,
    retry,
    clear,
    busy: items.some((u) => u.status === 'uploading'),
    ready: items.filter((u) => u.status === 'ready').map((u) => u.info!),
    failed: items.some((u) => u.status === 'failed'),
  };
}
