// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Label } from '@cenacle/ui/components/label';
import { cn } from '@cenacle/ui/lib/utils';
import {
  CODE_THEMES,
  DEFAULT_CUSTOM_THEME,
  FONT_LIBRARY,
  FONT_TEMPLATES,
  PRESET_SWATCHES,
  THEME_PRESETS,
  useDensity,
  useTheme,
} from '@cenacle/ui/theme';
import { CodeBlock } from '../chat/markdown/code-block';
import {
  appearanceQuery,
  DEFAULT_APPEARANCE,
  deleteFont,
  fontsQuery,
  uploadFont,
  type Appearance,
} from './appearance';
import { CustomThemeEditor } from './custom-theme-editor';
import { useSaveAppearance } from './use-save-appearance';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const SAMPLE = 'func greet(name string) string {\n\treturn "Merhaba, " + name + " => ≠ !="\n}';

/** Theme, preset, density, fonts, size and code blocks, with a live preview. */
export function AppearancePanel() {
  const { t } = useTranslation();
  const ids = {
    theme: useId(),
    density: useId(),
    template: useId(),
    text: useId(),
    code: useId(),
    size: useId(),
    line: useId(),
    codeTheme: useId(),
    font: useId(),
  };
  const query = useQuery(appearanceQuery);
  const a = query.data ?? DEFAULT_APPEARANCE;
  const fonts = useQuery(fontsQuery);
  const save = useSaveAppearance();
  const { setTheme } = useTheme();
  const { setDensity } = useDensity();
  const set = (patch: Partial<Appearance>) => save.mutate(patch);
  const setFonts = (patch: Partial<Appearance['fonts']>) =>
    set({ fonts: { ...a.fonts, ...patch } });
  const setCode = (patch: Partial<Appearance['code']>) => set({ code: { ...a.code, ...patch } });

  const own = fonts.data ?? [];
  const options = (kind: 'text' | 'code') => (
    <>
      {FONT_LIBRARY.filter((f) => f.kind === kind).map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
      {own.length > 0 && (
        <optgroup label={t('appearance.yourFonts')}>
          {own.map((f) => (
            <option key={f.id} value={`user:${f.id}`}>
              {f.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
  const custom = a.fonts.template === 'custom';
  // The custom preset shows the colors picked for it.
  const swatch = (p: (typeof THEME_PRESETS)[number]) =>
    p === 'custom'
      ? [
          (a.custom_theme ?? DEFAULT_CUSTOM_THEME).accent,
          (a.custom_theme ?? DEFAULT_CUSTOM_THEME).sidebar,
        ]
      : PRESET_SWATCHES[p];

  return (
    <div className="flex flex-col gap-5" data-testid="appearance-panel">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={ids.theme}>{t('appearance.theme')}</Label>
          <select
            id={ids.theme}
            className={selectClass}
            value={a.theme}
            onChange={(e) => {
              const v = e.target.value as Appearance['theme'];
              setTheme(v);
              set({ theme: v });
            }}
          >
            <option value="system">{t('appearance.themeSystem')}</option>
            <option value="light">{t('appearance.themeLight')}</option>
            <option value="dark">{t('appearance.themeDark')}</option>
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.density}>{t('appearance.density')}</Label>
          <select
            id={ids.density}
            className={selectClass}
            value={a.density}
            onChange={(e) => {
              const v = e.target.value as Appearance['density'];
              setDensity(v);
              set({ density: v });
            }}
          >
            <option value="auto">{t('appearance.densityAuto')}</option>
            <option value="compact">{t('appearance.densityCompact')}</option>
            <option value="comfortable">{t('appearance.densityComfortable')}</option>
          </select>
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('appearance.preset')}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('appearance.preset')}>
          {(['workspace', ...THEME_PRESETS] as const).map((p) => {
            const selected = a.preset === p;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() =>
                  set(
                    p === 'custom'
                      ? { preset: p, custom_theme: a.custom_theme ?? DEFAULT_CUSTOM_THEME }
                      : { preset: p },
                  )
                }
                className={cn(
                  'flex min-h-target items-center gap-2 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  selected ? 'border-ring bg-accent' : 'hover:bg-muted',
                )}
              >
                {p === 'workspace' ? (
                  <span
                    aria-hidden
                    className="size-4 rounded-full border border-dashed border-current"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="size-4 rounded-full"
                    style={{
                      background: `linear-gradient(135deg, ${swatch(p)[0]} 50%, ${swatch(p)[1]} 50%)`,
                    }}
                  />
                )}
                {t(`appearance.presets.${p}`)}
                {selected && <CheckIcon aria-hidden className="size-4" strokeWidth={1.75} />}
              </button>
            );
          })}
        </div>
        {a.preset === 'custom' && (
          <CustomThemeEditor
            live
            value={a.custom_theme ?? DEFAULT_CUSTOM_THEME}
            onChange={(custom_theme) => set({ custom_theme })}
          />
        )}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor={ids.template}>{t('appearance.fontTemplate')}</Label>
          <select
            id={ids.template}
            className={selectClass}
            value={a.fonts.template}
            onChange={(e) => {
              const template = e.target.value as Appearance['fonts']['template'];
              // Custom starts from the fonts of the template in use.
              const from =
                template === 'custom' && a.fonts.template in FONT_TEMPLATES
                  ? FONT_TEMPLATES[a.fonts.template as keyof typeof FONT_TEMPLATES]
                  : { text: a.fonts.text, code: a.fonts.code };
              setFonts({ template, ...from });
            }}
          >
            <option value="workspace">{t('appearance.templates.workspace')}</option>
            {Object.keys(FONT_TEMPLATES).map((k) => (
              <option key={k} value={k}>
                {t(`appearance.templates.${k}`)}
              </option>
            ))}
            <option value="custom">{t('appearance.templates.custom')}</option>
          </select>
        </div>
        {custom && (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.text}>{t('appearance.textFont')}</Label>
              <select
                id={ids.text}
                className={selectClass}
                value={a.fonts.text}
                onChange={(e) => setFonts({ text: e.target.value })}
              >
                {options('text')}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.code}>{t('appearance.codeFont')}</Label>
              <select
                id={ids.code}
                className={selectClass}
                value={a.fonts.code}
                onChange={(e) => setFonts({ code: e.target.value })}
              >
                {options('code')}
              </select>
            </div>
          </>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={ids.size}>{t('appearance.fontSize')}</Label>
          <select
            id={ids.size}
            className={selectClass}
            value={a.font_size}
            onChange={(e) => set({ font_size: Number(e.target.value) })}
          >
            {[12, 13, 14, 15, 16, 18, 20].map((n) => (
              <option key={n} value={n}>
                {n === 14 ? t('appearance.fontSizeDefault', { size: n }) : `${n} px`}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.line}>{t('appearance.lineHeight')}</Label>
          <select
            id={ids.line}
            className={selectClass}
            value={a.line_height}
            onChange={(e) => set({ line_height: e.target.value as Appearance['line_height'] })}
          >
            {(['compact', 'normal', 'relaxed'] as const).map((l) => (
              <option key={l} value={l}>
                {t(`appearance.lineHeights.${l}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('appearance.codeBlocks')}</legend>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.codeTheme}>{t('appearance.codeTheme')}</Label>
          <select
            id={ids.codeTheme}
            className={selectClass}
            value={a.code.theme}
            onChange={(e) => setCode({ theme: e.target.value as Appearance['code']['theme'] })}
          >
            {Object.keys(CODE_THEMES).map((k) => (
              <option key={k} value={k}>
                {t(`appearance.codeThemes.${k}`)}
              </option>
            ))}
          </select>
        </div>
        {(['line_numbers', 'wrap', 'ligatures'] as const).map((k) => (
          <label key={k} data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={a.code[k]}
              onChange={(e) => setCode({ [k]: e.target.checked })}
              className="size-4 accent-primary"
              // The whole label is the target (at least 24 px).
              data-target-exempt
            />
            {t(`appearance.code.${k}`)}
          </label>
        ))}
      </fieldset>

      <section aria-labelledby={`${ids.font}-title`} className="grid gap-2">
        <h4 id={`${ids.font}-title`} className="text-sm font-medium">
          {t('appearance.preview')}
        </h4>
        <div className="rounded-lg border p-3" data-testid="appearance-preview">
          <p className="text-sm" style={{ lineHeight: 'var(--line-height-base)' }}>
            {t('appearance.previewText')}
          </p>
          <CodeBlock code={SAMPLE} language="go" />
        </div>
      </section>

      <FontUploads />
    </div>
  );
}

const MAX_FONT = 2 * 1024 * 1024;

/** Fonts the person uploads for themselves. */
function FontUploads() {
  const { t } = useTranslation();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const fonts = useQuery(fontsQuery);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: fontsQuery.queryKey });
  const upload = useMutation({
    mutationFn: (f: File) => uploadFont(name.trim() || f.name.replace(/\.[^.]+$/, ''), f),
    onSuccess: () => {
      setName('');
      void refresh();
      toast.success(t('appearance.fontAdded'));
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.problem.code === 'font_limit'
          ? t('appearance.fontLimit')
          : err instanceof ApiError && (err.status === 422 || err.status === 413)
            ? t('appearance.fontInvalid')
            : t('appearance.saveFailed'),
      ),
  });
  const remove = useMutation({
    mutationFn: deleteFont,
    onSuccess: refresh,
    onError: () => toast.error(t('appearance.saveFailed')),
  });
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2" data-testid="font-uploads">
      <h4 id={`${id}-title`} className="text-sm font-medium">
        {t('appearance.yourFonts')}
      </h4>
      <p className="text-xs text-muted-foreground">{t('appearance.fontsHint')}</p>
      {fonts.data && fonts.data.length > 0 && (
        <ul className="grid gap-1">
          {fonts.data.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-xs text-muted-foreground uppercase">{f.format}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('appearance.fontRemove', { name: f.name })}
                onClick={() => remove.mutate(f.id)}
              >
                <Trash2Icon strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-40 flex-1 gap-1">
          <Label htmlFor={`${id}-name`}>{t('appearance.fontName')}</Label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className="min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <input
          ref={file}
          type="file"
          accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (f.size > MAX_FONT) toast.error(t('appearance.fontInvalid'));
            else upload.mutate(f);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={upload.isPending}
          onClick={() => file.current?.click()}
        >
          <UploadIcon aria-hidden strokeWidth={1.75} />
          {t('appearance.fontUpload')}
        </Button>
      </div>
    </section>
  );
}
