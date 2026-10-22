// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isDensityPreference,
  isThemePreference,
  useDensity,
  useTheme,
  type DensityPreference,
  type ThemePreference,
} from '@cenacle/ui/theme';
import { LANGUAGES, setLanguage, type Language } from '../../i18n';

const selectClass =
  'min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Theme, density and language. Native selects: keyboard, touch and screen reader friendly. */
export function AppearanceControls({
  onSave,
}: {
  /** Signed in: the choice is also saved for the person's other devices. */
  onSave?: (change: { theme?: ThemePreference; density?: DensityPreference }) => void;
} = {}) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const ids = { theme: useId(), density: useId(), lang: useId() };

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={ids.theme} className="sr-only">
        {t('appearance.theme')}
      </label>
      <select
        id={ids.theme}
        className={selectClass}
        value={theme}
        onChange={(e) => {
          const v = e.target.value;
          if (!isThemePreference(v)) return;
          setTheme(v);
          onSave?.({ theme: v });
        }}
      >
        <option value="system">{t('appearance.themeSystem')}</option>
        <option value="light">{t('appearance.themeLight')}</option>
        <option value="dark">{t('appearance.themeDark')}</option>
      </select>

      <label htmlFor={ids.density} className="sr-only">
        {t('appearance.density')}
      </label>
      <select
        id={ids.density}
        className={selectClass}
        value={density}
        onChange={(e) => {
          const v = e.target.value;
          if (!isDensityPreference(v)) return;
          setDensity(v);
          onSave?.({ density: v });
        }}
      >
        <option value="auto">{t('appearance.densityAuto')}</option>
        <option value="compact">{t('appearance.densityCompact')}</option>
        <option value="comfortable">{t('appearance.densityComfortable')}</option>
      </select>

      <label htmlFor={ids.lang} className="sr-only">
        {t('appearance.language')}
      </label>
      <select
        id={ids.lang}
        className={selectClass}
        value={i18n.resolvedLanguage}
        onChange={(e) => setLanguage(e.target.value as Language)}
      >
        {LANGUAGES.map((l) => (
          <option key={l} value={l}>
            {l === 'en' ? 'English' : 'Türkçe'}
          </option>
        ))}
      </select>
    </div>
  );
}
