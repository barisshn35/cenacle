# 0031. The interface rewrite: the record (v0.29)

- Status: accepted
- Date: 2026-10-23

## Context

Up to v0.28 the interface grew feature by feature on shadcn defaults: a light sidebar,
messages laid out like a generic chat, Inter as the default face. The v0.29 rewrite gives
Cenacle one considered look that fits technical and office teams, with enterprise trust
and daily speed weighted equally, and that does not read as playful or as a template.

The direction was worked out from a review of the old interface and several prototypes,
and approved on 2026-10-23. The approved design, its tokens and the HTML prototypes are in
[`docs/design/v0.29`](../design/v0.29/README.md).

## Decisions

1. **The record.** A conversation reads like minutes: who spoke and when stands in a
   right-aligned speaker margin (152px, 96px in side panels, folded above the text on
   phones), the words beside it at a 72ch measure. Channel details state a channel's
   governance as a title block; the Inbox is a board with fixed columns.
2. **Colour has jobs.** Paper and Bone neutrals in the work area, a Forest sidebar, a
   Night rail, a Night-tinted dark theme. Brass only for selection, focus and the primary
   action; red only for the reader's own mentions, errors and destructive actions. Brand
   colours never mean a status. Containers use 1px rules and 10px corners, never thick or
   black frames or coloured side stripes; the one shadow is the popover's.
3. **Tokens.** The shadcn roles keep their names and take the new values; new roles
   (panel, well, hover, rule-strong, the sidebar's own secondary text, hover and
   selection, avatar tints, the speaker margin, the popover shadow) derive from them, so
   the theme presets of v0.16 keep working. Every pair is checked against WCAG 2.2 AA by
   `scripts/check-contrast.mjs`; control outlines reach 3:1.
4. **Type.** Geist for everything and Geist Mono for record values (times, IDs, counts,
   dates, code). The default font template becomes **Modern** (Geist, Geist Mono) for
   every workspace that did not choose one; this supersedes the default of ADR 0013.
   Fraunces is no longer used.
5. **Public channels** carry the speech bubble of the logo; private channels a lock,
   announcements a megaphone. Never "#".
6. **The header** shows the channel's classification and retention as a governance chip
   that opens the details, instead of a coloured classification banner. Theme, density
   and language move from the header to Settings (a Language tab is added).
7. **The sidebar** keeps the daily views in sight (Activity, Threads, Saved, Tasks) and
   folds the others under More; Channels and Direct messages fold away. Settings sits at
   the foot of the rail.

## Consequences

- Text metrics and widths change; target sizes (WCAG 2.5.8) and axe are re-verified by the
  end-to-end suite on fine and coarse pointers.
- Workspaces that explicitly chose Corporate keep Inter; the others switch to Geist.
- The sign-in policy that ships with v0.29 (pairing by server address, a code from an
  authenticator app, sessions until sign-out, the web app that can be turned off) is
  recorded in its own ADR.
