// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { appearanceQuery, DEFAULT_APPEARANCE, saveAppearance, type Appearance } from './appearance';

/**
 * Saves a change of the appearance: shown at once (the settings in view change
 * in the same moment), then kept on the server. Saves go out in order; the
 * last one wins.
 */
export function useSaveAppearance() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: saveAppearance,
    scope: { id: 'appearance' },
    onError: () => {
      toast.error(t('appearance.saveFailed'));
      void queryClient.invalidateQueries({ queryKey: appearanceQuery.queryKey });
    },
  });
  const { mutate } = save;
  const change = useCallback(
    (patch: Partial<Appearance>) => {
      const current = queryClient.getQueryData(appearanceQuery.queryKey);
      const next: Appearance = { ...(current ?? DEFAULT_APPEARANCE), ...patch };
      queryClient.setQueryData(appearanceQuery.queryKey, next);
      mutate(next);
    },
    [queryClient, mutate],
  );
  return { mutate: change, isPending: save.isPending };
}
