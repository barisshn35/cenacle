// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { RotateCcwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { cn } from '@cenacle/ui/lib/utils';
import {
  applyCustomTheme,
  CUSTOM_RADII,
  CUSTOM_SURFACES,
  customThemeTokens,
  DEFAULT_CUSTOM_THEME,
  HEX_COLOR,
  type CustomTheme,
} from '@cenacle/ui/theme';

/** A few starting points for each color, with names for screen readers. */
type Swatch = { hex: string; name: string };
const ACCENTS: Swatch[] = [
  { hex: '#8f6b1f', name: 'brass' },
  { hex: '#0b5cad', name: 'blue' },
  { hex: '#1f7a4d', name: 'green' },
  { hex: '#b0420a', name: 'rust' },
  { hex: '#b0245c', name: 'raspberry' },
  { hex: '#6d28d9', name: 'violet' },
  { hex: '#0f766e', name: 'teal' },
  { hex: '#3f3f46', name: 'graphite' },
];
const SIDEBARS: Swatch[] = [
  { hex: '#14342b', name: 'forest' },
  { hex: '#0f1f3a', name: 'navy' },
  { hex: '#1e1b2e', name: 'aubergine' },
  { hex: '#2a0f1c', name: 'wine' },
  { hex: '#1c1c1c', name: 'charcoal' },
  { hex: '#f4f4f5', name: 'paper' },
  { hex: '#eef2f7', name: 'mist' },
  { hex: '#f6efe4', name: 'sand' },
];

const sameTheme = (a: CustomTheme, b: CustomTheme) =>
  a.accent === b.accent &&
  a.sidebar === b.sidebar &&
  a.surface === b.surface &&
  a.radius === b.radius;

/** How long a change rests before it is saved (dragging a color sends many). */
const SAVE_AFTER_MS = 400;

function ColorField({
  label,
  value,
  swatches,
  onChange,
}: {
  label: string;
  value: string;
  swatches: Swatch[];
  onChange: (hex: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // Picked another way (the color input or a swatch).
    setShown(value);
    setText(value);
  }
  const valid = HEX_COLOR.test(text);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          aria-label={t('appearance.custom.pick', { what: label })}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 min-h-target w-11 shrink-0 cursor-pointer rounded-md border border-input bg-background p-0.5"
        />
        <Input
          id={id}
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-invalid={!valid || undefined}
          aria-describedby={valid ? undefined : `${id}-error`}
          className="w-28 font-mono"
          onChange={(e) => {
            const v = e.target.value.trim();
            setText(v);
            if (HEX_COLOR.test(v)) onChange(v.toLowerCase());
          }}
          onBlur={() => setText(value)}
        />
      </div>
      {!valid && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {t('appearance.custom.invalidHex')}
        </p>
      )}
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label={t('appearance.custom.suggested')}
      >
        {swatches.map((s) => (
          <button
            key={s.hex}
            type="button"
            aria-label={t(`appearance.custom.colors.${s.name}`)}
            aria-pressed={s.hex === value}
            title={`${t(`appearance.custom.colors.${s.name}`)} ${s.hex}`}
            onClick={() => onChange(s.hex)}
            className={cn(
              // The edge keeps a swatch visible on a ground of its own color.
              'size-6 min-h-6 rounded-full border border-foreground/25 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:size-11',
              s.hex === value && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
            )}
            style={{ background: s.hex }}
          />
        ))}
      </div>
    </div>
  );
}

/** A small picture of the theme: the sidebar, a message and a button. */
function Preview({ theme, mode }: { theme: CustomTheme; mode: 'light' | 'dark' }) {
  const { t } = useTranslation();
  const tokens = customThemeTokens(theme, mode);
  const v = (k: string) => tokens[`--${k}`];
  return (
    <figure
      className="grid grid-cols-[5rem_1fr] overflow-hidden border text-xs"
      style={{ borderRadius: v('radius'), borderColor: v('border') } as CSSProperties}
    >
      <div className="grid content-start gap-1 p-2" style={{ background: v('sidebar') }}>
        <span style={{ color: v('sidebar-muted-foreground') }}>
          {t('appearance.custom.sampleChannels')}
        </span>
        <span
          className="rounded px-1 py-0.5"
          style={{ background: v('sidebar-accent'), color: v('sidebar-accent-foreground') }}
        >
          {t('appearance.custom.sampleChannel')}
        </span>
        <span style={{ color: v('sidebar-foreground') }}>{t('appearance.custom.sampleOther')}</span>
      </div>
      <div className="grid content-start gap-1.5 p-2" style={{ background: v('background') }}>
        <div
          className="grid gap-0.5 p-1.5"
          style={{ background: v('card'), borderRadius: v('radius'), color: v('foreground') }}
        >
          <b>{t('appearance.custom.sampleAuthor')}</b>
          <span>
            {t('appearance.custom.sampleText')}{' '}
            <u style={{ color: v('accent-brand') }}>{t('appearance.custom.sampleLink')}</u>
          </span>
          <span style={{ color: v('muted-foreground') }}>{t('appearance.custom.sampleTime')}</span>
        </div>
        <span
          className="justify-self-start px-2 py-1 font-medium"
          style={{
            background: v('accent-brand'),
            color: v('accent-brand-foreground'),
            borderRadius: `calc(${v('radius')} * 0.8)`,
          }}
        >
          {t('appearance.custom.sampleButton')}
        </span>
      </div>
      <figcaption className="sr-only">
        {mode === 'light'
          ? t('appearance.custom.previewLight')
          : t('appearance.custom.previewDark')}
      </figcaption>
    </figure>
  );
}

/**
 * Picks the colors of a custom theme. Changes show at once (with `live`, on
 * the whole page) and are passed on once they rest. Whatever is picked, the
 * app keeps text readable.
 */
export function CustomThemeEditor({
  value,
  onChange,
  live = false,
}: {
  value: CustomTheme;
  onChange: (theme: CustomTheme) => void;
  /** The page shows this theme now: changes show on it before they are saved. */
  live?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (!sameTheme(shown, value)) {
    // A saved value from elsewhere (another device) replaces the draft.
    setShown(value);
    setDraft(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (patch: Partial<CustomTheme>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (live) applyCustomTheme(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next), SAVE_AFTER_MS);
  };

  const choice = <K extends 'surface' | 'radius'>(
    key: K,
    options: readonly CustomTheme[K][],
    label: string,
  ) => (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={draft[key] === o}
            onClick={() => change({ [key]: o } as Partial<CustomTheme>)}
            className={cn(
              'min-h-target rounded-lg border px-2.5 text-sm outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50',
              draft[key] === o ? 'border-ring bg-accent' : 'hover:bg-muted',
            )}
          >
            {t(`appearance.custom.${key}s.${o}`)}
          </button>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="grid gap-4 rounded-lg border p-3" data-testid="custom-theme-editor">
      <div className="grid gap-4 sm:grid-cols-2">
        <ColorField
          label={t('appearance.custom.accent')}
          value={draft.accent}
          swatches={ACCENTS}
          onChange={(accent) => change({ accent })}
        />
        <ColorField
          label={t('appearance.custom.sidebar')}
          value={draft.sidebar}
          swatches={SIDEBARS}
          onChange={(sidebar) => change({ sidebar })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {choice('surface', CUSTOM_SURFACES, t('appearance.custom.surface'))}
        {choice('radius', CUSTOM_RADII, t('appearance.custom.radius'))}
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">{t('appearance.custom.preview')}</span>
        <div className="grid gap-2 sm:grid-cols-2" data-testid="custom-theme-preview">
          <Preview theme={draft} mode="light" />
          <Preview theme={draft} mode="dark" />
        </div>
        <p className="text-xs text-muted-foreground">{t('appearance.custom.readable')}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        onClick={() => change(DEFAULT_CUSTOM_THEME)}
      >
        <RotateCcwIcon strokeWidth={1.75} />
        {t('appearance.custom.reset')}
      </Button>
    </div>
  );
}
