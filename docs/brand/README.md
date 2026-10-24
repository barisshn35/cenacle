# Cenacle brand

Identity: **Fraunces** wordmark and icon direction **B "Upper room"**: an arch (a room, a
shared place) with a speech bubble inside. The logo is drawn in a **neutral ink with a brass
bubble** (refresh of 0.37.2); the interface keeps its Forest & Brass palette.

## Logo inks

| Token                 | Value     | Use                                                  |
| --------------------- | --------- | ---------------------------------------------------- |
| `--brand-ink`         | `#1A1A1A` | Logo arch and wordmark on white and light grounds    |
| `--brand-ink-on-dark` | `#F2F2F2` | Logo arch and wordmark on neutral dark grounds       |
| (on pure black)       | `#FFFFFF` | The `onblack` files                                  |
| `--brand-brass`       | `#C9A24B` | The bubble, on every ground                          |
| `--brand-tile-dark`   | `#121212` | Ground of the dark app icon (the light one is white) |

Contrast: ink on white 16.7:1, light ink on #161616 16.2:1; the bubble is a shape, not text.

## Interface palette

| Token               | Value     | Use                                                   |
| ------------------- | --------- | ----------------------------------------------------- |
| `--brand-forest`    | `#14342B` | Sidebar and board headers, headings on light          |
| `--brand-brass`     | `#C9A24B` | UI accent **on dark only**                            |
| `--brand-brass-ink` | `#8F6B1F` | UI accent **on light**: links, primary buttons, focus |
| `--brand-paper`     | `#FAF7F0` | Light surfaces                                        |
| `--brand-night`     | `#0C1A16` | Dark rail                                             |
| `--brand-bone`      | `#F3EEE2` | Text on Forest and Night                              |

The interface uses the semantic token `--accent-brand` (Brass-ink on light, Brass on
dark); primary buttons and focus rings follow it. Brand colours are never status colours:
online/away, warnings, errors, destructive actions and mentions keep their own tokens.

### Bright and dark brass

Bright brass (`#C9A24B`) is only 2.2:1 on Paper, so on light backgrounds it appears **only
as the logo bubble**, never as text, links, outlines or buttons. On light UI use Brass-ink
(`#8F6B1F`, 4.6:1 on Paper, 4.9:1 with white text). On dark UI bright brass is the accent
(7.4:1 on Night). `scripts/check-contrast.mjs` enforces this in CI.

## Typography

- Interface text: **Geist**. Code: **Geist Mono**.
- Brand headlines only (sign-in title, workspace welcome, empty states): **Fraunces**
  (`font-display`), medium weight, `SOFT 50`, `WONK 0`, optical size following the font
  size. Fallback: Georgia, serif.

## Logo

- **Minimum sizes:** icon 16 px; lockup 96 px wide (use the icon below that).
- **Clear space:** one bubble diameter on every side (see
  `web/public/brand/cenacle-clearspace-guide.svg` and the padded lockups).
- **Small sizes:** the 16 px favicon uses a heavier arch stroke (7.5 instead of 6.5);
  the `Logo` component does the same at 16 px.
- **In code:** use `Logo` from `@cenacle/ui/brand` (`variant="lockup" | "icon"`,
  `tone="brand" | "mono"`). Its colours come from `--logo-ink` and `--logo-accent`, so it
  follows the theme. Mark it `decorative` when the word "Cenacle" is visible next to it.

### Logo motion

On the project website the lockup may come in once, when the page opens:

1. the arch is drawn along its stroke (0.7 s),
2. the bubble settles inside it (scale 0.4 → 1, 0.24 s),
3. the letters of the wordmark appear one after another, C to e (0.3 s each, 70 ms
   apart, rising 4 units).

Easing `cubic-bezier(0.23, 1, 0.32, 1)`. The shapes, colours and proportions never change;
no glow, blur, bounce or loop. It plays once per page load, never on hover, and not at all
with `prefers-reduced-motion` or without JavaScript (the logo then simply shows). The app
itself does not animate the logo.

### Do not

- recolour the logo outside its inks and brass, or use brass for the arch;
- stretch, skew or rotate it; change the arch/bubble proportions;
- add shadows, glows, outlines, gradients or other effects;
- reset the wordmark in another typeface or retype it as live text;
- place it on busy images or low-contrast backgrounds.

## Files

The lockup, icon and favicon files are animation-ready: `<g id="icon">` holds
`<path id="arch">` (one open stroke, drawn from the left foot over the top to the right
foot) and `<path id="bubble">`; `<g id="wordmark">` holds one path per letter (`C`, `e1`,
`n1`, `a`, `c`, `l`, `e2`). The editable master with the 48-unit grid and construction
guides is `docs/brand/cenacle-source.svg`. The wordmark is Fraunces Medium (opsz 72, SOFT 50,
WONK 0, tracking −1.5 %), outlined.

All files are plain-path SVGs (no fonts, scripts or external references). Embedded C2PA
provenance metadata from the design export is removed from the served copies.

| File (`web/public/brand/`)                      | Use                                  |
| ----------------------------------------------- | ------------------------------------ |
| `cenacle-lockup-light.svg` / `-dark.svg`        | Lockup on light / dark backgrounds   |
| `cenacle-lockup-padded-light.svg` / `-dark.svg` | Lockup with clear space              |
| `cenacle-wordmark-light.svg` / `-dark.svg`      | Wordmark alone                       |
| `cenacle-icon-light.svg` / `-dark.svg`          | Icon                                 |
| `cenacle-appicon-light.svg` / `-dark.svg`       | App icon with background             |
| `favicon-16-*.svg`, `favicon-32-*.svg`          | Favicons (16 px with heavier stroke) |
| `cenacle-{icon,lockup}-{black,white}.svg`       | Single-colour versions               |
| `cenacle-icon-mono-{black,white}.svg`           | One colour in the logo inks          |
| `cenacle-{icon,lockup,wordmark}-onblack.svg`    | On pure black (#FFFFFF ink)          |
| `cenacle-clearspace-guide.svg`                  | Clear space guide                    |

Generated by `make brand` (committed): `web/public/apple-touch-icon.png` (180),
`icon-192.png`, `icon-512.png` (dark app icon) and `favicon.ico` (32, light favicon).
`web/public/favicon.svg` follows the system theme; `favicon-dark.svg` is the dark variant
for browsers that honour `media` on icon links.
