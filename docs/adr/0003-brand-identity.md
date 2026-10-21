# 0003. Brand identity: Forest & Brass and Fraunces

- Status: accepted
- Date: 2026-10-21

## Context

The skeleton used a neutral graphite palette as a placeholder. The chosen identity is the
**Forest & Brass** palette, a **Fraunces** wordmark and the **"Upper room"** icon (arch with
a speech bubble). It has to work in light and dark themes, meet WCAG 2.2 AA and stay
self-hosted.

## Decisions

1. **Palette as tokens.** Brand constants (`--brand-forest`, `--brand-brass`,
   `--brand-brass-ink`, `--brand-paper`, `--brand-night`, `--brand-bone`) live in
   `@cenacle/ui/tokens.css`. Surfaces move to Paper (light) and Night (dark); the neutral
   scale is warm and slightly green so cards, sidebars and borders sit with the brand
   colours. Form control outlines are raised to 3:1 (WCAG 1.4.11).
2. **A separate brass for light UI.** Bright brass `#C9A24B` is 2.2:1 on Paper, too low for
   text, links or focus indicators. Light UI therefore uses Brass-ink `#8F6B1F` (4.6:1 on
   Paper, 4.9:1 with white button text) through the semantic `--accent-brand`; dark UI uses
   bright brass (7.4:1 on Night, Night text on brass buttons). Bright brass stays in the
   logo on every background.
3. **Primary actions use `--accent-brand`.** Primary buttons and focus rings are brass
   (Brass-ink on light). The logo pack also suggests Bone-on-Forest primary buttons; the
   brand task asked for the accent, which keeps one interactive colour across themes.
4. **Brand and status colours never mix.** Online/away/do-not-disturb, warnings, errors,
   destructive actions and mentions keep their own tokens; green, red and yellow status
   signals are not replaced by Forest or Brass.
5. **Fraunces only for brand headlines** (sign-in title, workspace welcome, empty states),
   `font-display`, medium, `SOFT 50`, `WONK 0`, automatic optical size; interface text stays
   Geist for legibility at small sizes. Fontsource's "full" files are the only ones with
   both the opsz and SOFT axes; Latin and Latin Extended are loaded (Turkish ğ ş ı İ),
   Vietnamese and italics are not. Fraunces is SIL OFL-1.1, like Geist: it is added to the
   font exception list of the license policy.
6. **Logo in code, not images.** `Logo` renders the paths of the logo pack inline with
   colours from `--logo-ink` / `--logo-accent`, so it follows the theme. The lockup's icon is
   small relative to the wordmark by design; the lockup is used from 96 px width, the icon
   alone below that.
7. **Favicons.** `favicon.svg` switches its arch colour with `prefers-color-scheme` inside
   the SVG, because Chromium does not honour `media` on icon links; `favicon-dark.svg` is
   linked with `media` for browsers that do. PNG icons and `favicon.ico` are rendered from
   the SVGs with `@resvg/resvg-js` (MPL-2.0, already allowed) by `make brand` and committed.
8. **Provenance metadata.** The design export embeds C2PA manifests (about 7 KB per file);
   they are stripped from the served copies, which contain only paths.

## Consequences

- Every surface (web app, Cenacle ID pages) follows the brand through the shared tokens.
- `scripts/check-contrast.mjs` (part of `pnpm lint`) fails CI if a theme change breaks the
  contrast rules, e.g. bright brass as a light-theme accent.
