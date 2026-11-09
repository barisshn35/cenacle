// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { setStickerSaved, stickersQuery } from './richer';

/** Saves a sticker for oneself or takes it out, keeping the picker's list in step. */
export function useSaveSticker(workspaceId: string | undefined) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, saved }: { id: string; saved: boolean }) => setStickerSaved(id, saved),
    onSuccess: (_, { id, saved }) => {
      queryClient.setQueryData(stickersQuery(workspaceId).queryKey, (list) =>
        list?.map((s) => (s.id === id ? { ...s, saved } : s)),
      );
      toast.success(saved ? t('richer.stickers.saved') : t('richer.stickers.unsaved'));
    },
    onError: () => toast.error(t('richer.stickers.saveFailed')),
  });
}

/** A GIF too large to keep, found before sending it. */
export class GifTooLarge extends Error {}

/** What went wrong keeping a GIF, in words. */
export function gifError(err: unknown, t: (key: string) => string): string {
  if (err instanceof GifTooLarge) return t('richer.gifs.tooLarge');
  if (err instanceof ApiError) {
    if (err.problem.code === 'gif_limit') return t('richer.gifs.limit');
    if (err.problem.code === 'not_a_gif') return t('richer.gifs.notGif');
    if (err.problem.status === 413) return t('richer.gifs.tooLarge');
  }
  return t('richer.gifs.addFailed');
}
