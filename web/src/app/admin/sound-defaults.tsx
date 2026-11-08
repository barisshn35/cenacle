// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { notificationsQuery } from '../notifications/notifications';
import { SoundChoice } from '../notifications/notifications-panel';
import { BUILTIN_SOUNDS } from '../notifications/sounds';

type SoundDefaults = components['schemas']['SoundDefaults'];
const KEY = ['admin', 'sound-defaults'];
const put = (d: SoundDefaults) =>
  apiFetch<SoundDefaults>('/api/admin/sound-defaults', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(d),
  });

/**
 * The installation's notification sounds: heard by everyone who has not
 * chosen their own, and given to everyone on request.
 */
export function SoundDefaultsSection() {
  const { t } = useTranslation();
  const ids = { title: useId(), volume: useId() };
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<SoundDefaults>('/api/admin/sound-defaults'),
  });
  // Shown as chosen at once; a failed change goes back to what is saved.
  const [chosen, setChosen] = useState<SoundDefaults | null>(null);
  const [confirm, setConfirm] = useState(false);
  const set = useMutation({
    mutationFn: put,
    onSuccess: (d) => {
      queryClient.setQueryData(KEY, d);
      setChosen(null);
      void queryClient.invalidateQueries({ queryKey: notificationsQuery.queryKey });
    },
    onError: () => {
      setChosen(null);
      toast.error(t('console.changeFailed'));
    },
  });
  // The volume is saved once the slider rests.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!saved.data) return <Skeleton className="h-40" />;
  const value = chosen ?? saved.data;
  const choose = (next: SoundDefaults, later = false) => {
    setChosen(next);
    clearTimeout(timer.current);
    if (later) timer.current = setTimeout(() => set.mutate(next), 400);
    else set.mutate(next);
  };
  const options = (
    <>
      <option value="none">{t('notifications.sounds.none')}</option>
      {BUILTIN_SOUNDS.map((s) => (
        <option key={s} value={s}>
          {t(`notifications.sounds.${s}`)}
        </option>
      ))}
    </>
  );
  return (
    <section aria-labelledby={ids.title} className="grid gap-3" data-testid="sound-defaults">
      <div className="grid gap-1">
        <h3 id={ids.title} className="text-sm font-semibold">
          {t('console.soundDefaults.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('console.soundDefaults.hint')}</p>
      </div>
      {(['mention', 'direct', 'message'] as const).map((k) => (
        <SoundChoice
          key={k}
          label={t(`notifications.for.${k}`)}
          value={value.sounds[k]}
          volume={value.volume}
          options={options}
          onChange={(v) => choose({ ...value, sounds: { ...value.sounds, [k]: v } })}
        />
      ))}
      <div className="grid gap-1.5">
        <Label htmlFor={ids.volume}>{t('notifications.volume', { volume: value.volume })}</Label>
        <input
          id={ids.volume}
          type="range"
          min={0}
          max={100}
          step={5}
          value={value.volume}
          onChange={(e) => choose({ ...value, volume: Number(e.target.value) }, true)}
          className="min-h-target accent-primary"
        />
      </div>
      <div>
        <Button type="button" variant="outline" onClick={() => setConfirm(true)}>
          {t('console.soundDefaults.apply')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        severity="s2"
        title={t('console.soundDefaults.applyTitle')}
        description={t('console.soundDefaults.applyHint')}
        confirmLabel={t('console.soundDefaults.apply')}
        onConfirm={async () => {
          const r = await apiFetch<{ changed: number }>('/api/admin/sound-defaults/apply', {
            method: 'POST',
          });
          void queryClient.invalidateQueries({ queryKey: notificationsQuery.queryKey });
          setConfirm(false);
          toast.success(t('console.soundDefaults.applied', { count: r.changed }));
        }}
      />
    </section>
  );
}
