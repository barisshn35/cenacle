# 0019. Appearance: theme presets, fonts, code blocks and interface texts (v0.16)

- Status: accepted
- Date: 2026-10-22

## Context

Organisations want Cenacle in their colours and type; people want to read comfortably, in
their own fonts and code colours; administrators want to name their organisation on the
sign-in page. Everything must stay accessible (WCAG 2.2 AA) and work offline (no CDN).

## Decisions

1. **Settings live on the server** (`user_preferences.appearance`, JSON) so they follow a
   person to every device; the page also keeps the last resolved appearance locally and
   applies it before the first paint (no flash). Unknown or invalid stored settings fall
   back to the defaults, so later versions can add settings freely.
2. **Theme presets** (Cenacle, Graphite, Ocean, Forest, Sunset, Rose, High contrast) set the
   accent and the neutral surfaces of both themes as `data-preset` on `<html>`
   (`presets.css`). Status colours (mentions, errors, presence) never change.
   `scripts/check-contrast.mjs` checks every pair of every preset in both themes; CI fails
   below AA.
3. **Fonts**: the library of ADR 0013 (ten text and ten code fonts, OFL, from Fontsource,
   served by us; a face is downloaded only when used), six templates and own combinations.
   Text size 12–20 px scales the interface from the 14 px design size; target sizes stay in
   pixels, so they never shrink. Line spacing applies to message text.
4. **Uploaded fonts** (WOFF2, WOFF, TrueType, OpenType, recognised by their first bytes,
   2 MB, five per person) are stored in the database and served only to their owner with
   `nosniff` and a sandboxing CSP; the browser's font sanitiser (OTS) parses them. People are
   told to respect the font's licence.
5. **Workspace defaults**: owners and admins set the preset and font template a workspace
   shows; a person's "Workspace's" choice follows the workspace in view.
6. **Code blocks**: six code themes (shiki, loaded on first use), line numbers, wrapping and
   ligatures; GitHub high contrast stays the default for its contrast.
7. **Interface texts**: instance administrators replace an allow-listed set of texts (the
   sign-in page and two chat texts) per language; `/api/ui-texts` is public so the sign-in
   page uses them. Empty means the bundled text. Changes are audited.

## Consequences

- The web build carries the font files of the whole library (served from our origin); only
  the fonts in use are downloaded.
- Some code themes have lower contrast than the default; they are a personal choice.
