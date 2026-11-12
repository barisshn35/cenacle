// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { setEffects, useEffects, type NoiseMode } from './effects';

const selectClass =
  'min-h-target h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * Noise suppression and background blur, before joining and during a call.
 * `onChange` hears which kind changed (to apply it to what is being sent).
 */
export function EffectControls({ onChange }: { onChange?: (kind: 'audio' | 'camera') => void }) {
  const { t } = useTranslation('calls');
  const ids = { noise: useId(), blur: useId() };
  const { noise, background } = useEffects();
  return (
    <div className="grid gap-3" data-testid="call-effects">
      <div className="grid gap-1.5">
        <label htmlFor={ids.noise} className="text-sm font-medium">
          {t('effects.noise')}
        </label>
        <select
          id={ids.noise}
          className={selectClass}
          value={noise}
          aria-describedby={`${ids.noise}-hint`}
          onChange={(e) => {
            setEffects({ noise: e.target.value as NoiseMode });
            onChange?.('audio');
          }}
        >
          <option value="standard">{t('effects.noiseStandard')}</option>
          <option value="strong">{t('effects.noiseStrong')}</option>
          <option value="off">{t('effects.noiseOff')}</option>
        </select>
        <p id={`${ids.noise}-hint`} className="text-xs text-muted-foreground">
          {t(`effects.noiseHint.${noise}`)}
        </p>
      </div>
      <label
        htmlFor={ids.blur}
        data-target
        className="flex min-h-target items-center gap-2 text-sm"
      >
        <input
          id={ids.blur}
          type="checkbox"
          checked={background === 'blur'}
          onChange={(e) => {
            setEffects({ background: e.target.checked ? 'blur' : 'none' });
            onChange?.('camera');
          }}
          className="size-4 accent-(--accent-brand)"
          data-target-exempt
        />
        <span>
          {t('effects.blur')}
          <span className="block text-xs text-muted-foreground">{t('effects.blurHint')}</span>
        </span>
      </label>
    </div>
  );
}
