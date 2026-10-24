// SPDX-License-Identifier: AGPL-3.0-only
// Brand section of the development gallery: logo, files, favicons, app icons,
// brand tokens and their contrast in the current theme.

import { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AppIcon, Logo } from '@cenacle/ui/brand';

/** Resolves a CSS color (any syntax) to sRGB by painting one canvas pixel. */
function rgbOf(cssColor: string): [number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance([r, g, b]: [number, number, number]) {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function ratio(fg: string, bg: string) {
  const [hi, lo] = [luminance(rgbOf(cssVar(fg))), luminance(rgbOf(cssVar(bg)))].sort(
    (a, b) => b - a,
  );
  return (hi! + 0.05) / (lo! + 0.05);
}

const SWATCHES = [
  '--brand-forest',
  '--brand-brass',
  '--brand-brass-ink',
  '--brand-paper',
  '--brand-night',
  '--brand-bone',
  '--accent-brand',
];

const PAIRS: [string, string, number][] = [
  ['--foreground', '--background', 4.5],
  ['--accent-brand', '--background', 4.5],
  ['--primary-foreground', '--primary', 4.5],
  ['--muted-foreground', '--background', 4.5],
  ['--ring', '--background', 3],
  ['--input', '--background', 3],
];

/** The theme applied to <html> (changes after ThemeProvider's layout effect). */
function useAppliedTheme() {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      return () => observer.disconnect();
    },
    () => document.documentElement.dataset.theme ?? 'light',
  );
}

function Panel({ theme, children }: { theme: 'light' | 'dark'; children: React.ReactNode }) {
  // Fixed brand surfaces, independent of the page theme.
  return (
    <div
      className={
        theme === 'light'
          ? 'flex flex-wrap items-end gap-6 rounded-lg bg-brand-paper p-4 text-brand-forest'
          : 'flex flex-wrap items-end gap-6 rounded-lg bg-brand-night p-4 text-brand-bone'
      }
    >
      {children}
    </div>
  );
}

function Img({ file, alt, height }: { file: string; alt: string; height: number }) {
  return <img src={`/brand/${file}`} alt={alt} style={{ height }} />;
}

export function BrandSection() {
  const { t } = useTranslation();
  const theme = useAppliedTheme();
  const ratios = useMemo(
    () => PAIRS.map(([fg, bg]) => ratio(fg, bg)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when the theme changes
    [theme],
  );

  const h = 'text-xs font-medium tracking-wide text-muted-foreground uppercase';
  return (
    <div className="flex flex-col gap-6" data-testid="brand-section">
      <div className="flex flex-col gap-3">
        <h3 className={h}>{t('gallery.sections.brandLogo')}</h3>
        <div className="flex flex-wrap items-end gap-8">
          <Logo variant="lockup" size={40} />
          <Logo variant="lockup" size={18} />
          <Logo variant="icon" size={48} />
          <Logo variant="icon" size={24} />
          <Logo variant="icon" size={16} />
          <span className="text-muted-foreground">
            <Logo variant="lockup" size={24} tone="mono" />
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={h}>{t('gallery.sections.brandFiles')}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <Panel theme="light">
            <Img file="cenacle-lockup-light.svg" alt="Cenacle lockup, light" height={32} />
            <Img file="cenacle-icon-light.svg" alt="Cenacle icon, light" height={40} />
            <Img file="cenacle-wordmark-light.svg" alt="Cenacle wordmark, light" height={24} />
          </Panel>
          <Panel theme="dark">
            <Img file="cenacle-lockup-dark.svg" alt="Cenacle lockup, dark" height={32} />
            <Img file="cenacle-icon-dark.svg" alt="Cenacle icon, dark" height={40} />
            <Img file="cenacle-wordmark-dark.svg" alt="Cenacle wordmark, dark" height={24} />
          </Panel>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={h}>{t('gallery.sections.brandFavicons')}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          {(['light', 'dark'] as const).map((theme) => (
            <Panel key={theme} theme={theme}>
              {[16, 24, 32, 64].map((size) => (
                <figure key={size} className="flex flex-col items-center gap-1">
                  <img
                    src={`/brand/favicon-${size === 16 ? 16 : 32}-${theme}.svg`}
                    alt={`Favicon ${size} px, ${theme}`}
                    width={size}
                    height={size}
                  />
                  <figcaption className="text-xs">{size}</figcaption>
                </figure>
              ))}
            </Panel>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={h}>{t('gallery.sections.brandOneColor')}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <Panel theme="light">
            <Img file="cenacle-lockup-black.svg" alt="Cenacle lockup, black" height={24} />
            <Img file="cenacle-lockup-forest.svg" alt="Cenacle lockup, forest" height={24} />
            <Img file="cenacle-icon-black.svg" alt="Cenacle icon, black" height={32} />
            <Img file="cenacle-icon-forest.svg" alt="Cenacle icon, forest" height={32} />
          </Panel>
          <Panel theme="dark">
            <Img file="cenacle-lockup-white.svg" alt="Cenacle lockup, white" height={24} />
            <Img file="cenacle-icon-white.svg" alt="Cenacle icon, white" height={32} />
            <Img file="cenacle-lockup-onblack.svg" alt="Cenacle lockup, on black" height={24} />
            <Img file="cenacle-icon-onblack.svg" alt="Cenacle icon, on black" height={32} />
          </Panel>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={h}>{t('gallery.sections.brandAppIcon')}</h3>
        <div className="flex flex-wrap items-end gap-4">
          <AppIcon appearance="light" size={64} />
          <AppIcon appearance="dark" size={64} />
          <AppIcon appearance="dark" size={32} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={h}>{t('gallery.sections.brandTokens')}</h3>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {SWATCHES.map((name) => (
            <li key={name} className="flex flex-col gap-1 text-xs">
              <span
                aria-hidden
                className="h-10 rounded-md border"
                style={{ background: `var(${name})` }}
              />
              <code className="font-mono">{name}</code>
            </li>
          ))}
        </ul>
        <table className="w-full max-w-2xl text-sm" data-testid="contrast-table">
          <tbody>
            {PAIRS.map(([fg, bg, min], i) => (
              <tr key={fg + bg} className="border-b">
                <td className="py-1.5 pe-3">
                  {min >= 4.5 ? (
                    // Text pair: sample text in the foreground color.
                    <span
                      className="inline-flex h-7 items-center rounded px-2 font-medium"
                      style={{ color: `var(${fg})`, background: `var(${bg})` }}
                    >
                      Aa
                    </span>
                  ) : (
                    // UI pair (focus ring, outline): shown as a border, not as text.
                    <span
                      aria-hidden
                      className="inline-flex h-7 w-10 items-center justify-center rounded"
                      style={{ background: `var(${bg})` }}
                    >
                      <span
                        className="size-4 rounded-sm border-2"
                        style={{ borderColor: `var(${fg})` }}
                      />
                    </span>
                  )}
                </td>
                <td className="py-1.5 pe-3 font-mono text-xs">
                  {fg} / {bg}
                </td>
                <td className="py-1.5 tabular-nums" data-ratio={ratios[i]?.toFixed(2)}>
                  {ratios[i] !== undefined &&
                    t('gallery.sections.brandRatio', { ratio: ratios[i]!.toFixed(2), min })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
