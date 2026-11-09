// SPDX-License-Identifier: AGPL-3.0-only
// The custom theme preset: a person or a workspace picks an accent, a sidebar
// color, a tone for the surfaces and how round corners are; the tokens of both
// themes are made from these. Every text pair the presets are held to
// (scripts/check-contrast.mjs) is made to meet WCAG 2.2 AA here, whatever was
// picked: colors that would fall short are made lighter or darker.

export const CUSTOM_SURFACES = ['neutral', 'warm', 'cool', 'tinted'] as const;
export const CUSTOM_RADII = ['sharp', 'default', 'round'] as const;
export type CustomSurface = (typeof CUSTOM_SURFACES)[number];
export type CustomRadius = (typeof CUSTOM_RADII)[number];

export interface CustomTheme {
  /** "#rrggbb": buttons, links, focus rings. */
  accent: string;
  /** "#rrggbb": the sidebar and the workspace rail. */
  sidebar: string;
  surface: CustomSurface;
  radius: CustomRadius;
}

/** Cenacle's own colors, as a starting point. */
export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  accent: '#8f6b1f',
  sidebar: '#14342b',
  surface: 'warm',
  radius: 'default',
};

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const isCustomTheme = (c: unknown): c is CustomTheme => {
  const t = c as Partial<CustomTheme> | null;
  return (
    !!t &&
    typeof t.accent === 'string' &&
    HEX_COLOR.test(t.accent) &&
    typeof t.sidebar === 'string' &&
    HEX_COLOR.test(t.sidebar) &&
    CUSTOM_SURFACES.includes(t.surface as CustomSurface) &&
    CUSTOM_RADII.includes(t.radius as CustomRadius)
  );
};

// --- color: sRGB hex <-> OKLCH, WCAG contrast --------------------------------

type Rgb = [number, number, number];
export type Oklch = { l: number; c: number; h: number };

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToLinear(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255)) as Rgb;
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToLinear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The color as hex; out of the sRGB gamut, chroma is lowered until it fits. */
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  let lo = 0;
  let hi = color.c;
  let rgb = oklchToLinear({ ...color, l });
  if (!inGamut(rgb)) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, l, c: mid }))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinear({ ...color, l, c: lo });
  }
  return (
    '#' +
    rgb
      .map((v) =>
        Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

const luminance = (hex: string) => {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio of two hex colors. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The color moved in lightness (keeping hue and chroma) until it has `min`
 * contrast with every one of `against`: darker on light grounds, lighter on
 * dark ones. Unchanged when it already does.
 */
export function withContrast(hex: string, against: string[], min: number): string {
  const ok = (h: string) => against.every((b) => contrast(h, b) >= min);
  if (ok(hex)) return hex;
  const color = hexToOklch(hex);
  const darker = luminance(against[0]!) > 0.18;
  for (let step = 1; step <= 100; step++) {
    const l = darker ? color.l - step * 0.01 : color.l + step * 0.01;
    const next = oklchToHex({ ...color, l });
    if (ok(next)) return next;
  }
  return darker ? '#000000' : '#ffffff';
}

/** Black or white, whichever reads better on `bg`. */
const inkOn = (bg: string, dark = '#141414', light = '#ffffff') =>
  contrast(dark, bg) >= contrast(light, bg) ? dark : light;

// --- the tokens ------------------------------------------------------------

/** Hue and chroma of the neutral surfaces for each tone. */
function tone(surface: CustomSurface, accent: Oklch): { c: number; h: number } {
  switch (surface) {
    case 'warm':
      return { c: 0.012, h: 75 };
    case 'cool':
      return { c: 0.012, h: 250 };
    case 'tinted':
      return { c: Math.min(0.02, accent.c * 0.25), h: accent.h };
    default:
      return { c: 0, h: 0 };
  }
}

export const RADIUS: Record<CustomRadius, string> = {
  sharp: '0.25rem',
  default: '0.625rem',
  round: '1rem',
};

/** The tokens of one theme of a custom preset, as hex colors (and the radius). */
export function customThemeTokens(t: CustomTheme, mode: 'light' | 'dark'): Record<string, string> {
  const accent = hexToOklch(t.accent);
  const { c, h } = tone(t.surface, accent);
  const surface = (l: number) => oklchToHex({ l, c, h });
  const dark = mode === 'dark';

  const background = surface(dark ? 0.18 : 0.985);
  const card = surface(dark ? 0.205 : 1);
  const muted = surface(dark ? 0.25 : 0.955);
  const hover = surface(dark ? 0.28 : 0.93);
  const foreground = surface(dark ? 0.93 : 0.2);
  const grounds = [background, card, muted, hover];
  const mutedForeground = withContrast(surface(dark ? 0.74 : 0.5), grounds, 4.5);
  const border = surface(dark ? 0.3 : 0.9);
  const input = withContrast(surface(dark ? 0.55 : 0.62), [background, card], 3);

  // The accent: in the dark theme lighter, so that it stands out on dark grounds.
  const picked = dark ? oklchToHex({ ...accent, l: Math.max(accent.l, 0.72) }) : t.accent;
  const brand = withContrast(picked, [background, card], 4.5);
  const brandInk = inkOn(brand);

  // The sidebar keeps its color; in the dark theme it is no lighter than a dark ground.
  const side = hexToOklch(t.sidebar);
  const pickedSide = dark && side.l > 0.3 ? oklchToHex({ ...side, l: 0.24 }) : t.sidebar;
  const sideInk = inkOn(pickedSide, '#1a1a1a', '#f5f3ee');
  // A middle tone neither ink reads on is moved away from the ink.
  const sidebar = withContrast(pickedSide, [sideInk], 4.5);
  const sideDark = luminance(sidebar) < 0.18;
  const sideTone = hexToOklch(sidebar);
  const shade = (dl: number) => oklchToHex({ ...sideTone, l: sideTone.l + (sideDark ? dl : -dl) });
  const sidebarAccent = shade(0.08);
  const sidebarHover = shade(0.05);
  const sidebarMuted = withContrast(
    oklchToHex({ ...hexToOklch(sideInk), l: hexToOklch(sideInk).l + (sideDark ? -0.15 : 0.2) }),
    [sidebar, sidebarHover],
    4.5,
  );
  const sidebarActiveInk = withContrast(sideInk, [sidebarAccent], 4.5);
  // Its own accent: the picked one, made to show on the sidebar.
  const sidebarPrimary = withContrast(
    oklchToHex({ ...accent, l: sideDark ? Math.max(accent.l, 0.75) : Math.min(accent.l, 0.45) }),
    [sidebar],
    3,
  );

  return {
    '--background': background,
    '--foreground': foreground,
    '--card': card,
    '--popover': card,
    '--secondary': muted,
    '--muted': muted,
    '--muted-foreground': mutedForeground,
    '--accent': hover,
    '--border': border,
    '--input': input,
    '--accent-brand': brand,
    '--accent-brand-foreground': brandInk,
    '--sidebar': sidebar,
    '--sidebar-foreground': sideInk,
    '--sidebar-muted-foreground': sidebarMuted,
    '--sidebar-accent': sidebarAccent,
    '--sidebar-accent-foreground': sidebarActiveInk,
    '--sidebar-hover': sidebarHover,
    '--sidebar-border': shade(0.1),
    '--sidebar-primary': sidebarPrimary,
    '--sidebar-primary-foreground': inkOn(sidebarPrimary),
    '--sidebar-ring': sidebarPrimary,
    '--rail': shade(-0.05),
    '--radius': RADIUS[t.radius],
  };
}

const block = (selector: string, tokens: Record<string, string>) =>
  `${selector} {\n${Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')}\n}`;

/** The style sheet of the custom preset, for both themes. */
export function customThemeCss(t: CustomTheme): string {
  return [
    block("[data-preset='custom']", customThemeTokens(t, 'light')),
    block("[data-preset='custom'][data-theme='dark']", customThemeTokens(t, 'dark')),
  ].join('\n');
}

const STYLE_ID = 'cenacle-custom-theme';

/** Puts the custom preset's style sheet into the page, or takes it out. */
export function applyCustomTheme(
  t: CustomTheme | null | undefined,
  doc: Document = document,
): void {
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!t || !isCustomTheme(t)) {
    el?.remove();
    return;
  }
  const css = customThemeCss(t);
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}
