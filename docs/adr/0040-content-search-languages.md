# 0040. Search inside files, canvases and lists; more languages and right to left (v0.37)

- Status: accepted
- Date: 2026-10-24

## Context

Items C1 and L2 of the 2026-10-23 plan. Search found messages and file names (ADR 0020) but
not what files, canvases and lists say (ADR 0027). The interface was English and Turkish,
with physical left/right styling throughout.

## Decisions

1. **File text is read in the server's process**, by a background job after the scan:
   plain text, PDF (`github.com/ledongthuc/pdf`, BSD-3-Clause, a commit older than two
   weeks), Office Open XML and OpenDocument read as ZIP + XML with the standard library. No
   external tool (no Tika, no LibreOffice), so air-gapped installs need nothing more. Files
   are bounded (25 MB read, 200 000 characters kept), parsing errors are contained (a PDF
   that panics gives no text), and a file that has no readable text is marked so and not
   tried again. Text lives in the file row; deleting or redacting the file deletes it.
2. **The same search expression everywhere** (`cenacle_search_vector`: lower case, Turkish i
   folded, accents removed) indexes file text, canvases and list rows with expression GIN
   indexes, so they behave like message search. Excerpts are cut in Go from the original
   text with the same folding, because `ts_headline` over the original text cannot match
   the folded query.
3. **Translations are bundled resources** checked in CI: every language must have English's
   keys and placeholders (Arabic: CLDR's six plural forms). German, French, Spanish and
   Arabic were added; Cenacle ID and the desktop app follow the same languages. Community
   translation can run through a self-hosted Weblate (GPL, as its own service) against the
   repository; no translation service is called by Cenacle.
4. **Right to left via the document direction and logical CSS:** `<html dir>` follows the
   language, layouts use logical utilities (`ms-`, `pe-`, `start-`, `text-start`, `border-s`
   …; converted mechanically and reviewed, centering kept physical), and icons that point a
   way are mirrored by one stylesheet rule. Tests run the app in Arabic with the accessibility
   and target-size checks.

## Consequences

- Migration `00043_content_search`, reversible; existing files are read in the background
  after the upgrade (ten every ten seconds).
- A new PDF dependency in the server (BSD-3-Clause).
- Machine-assisted first translations; corrections come from native speakers.
