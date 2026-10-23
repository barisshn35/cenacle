---
name: Cenacle
description: Team chat that reads like the minutes of an assembly. Paper, Forest ink, a speaker margin, Brass only where you act.
colors:
  # Brand (binding, PRODUCT.md)
  night: "#0c1a16"
  forest: "#14342b"
  bone: "#f3eee2"
  paper: "#faf7f0"
  brass: "#c9a24b"
  brass-ink: "#8f6b1f"
  # Light theme roles (:root)
  sheet: "#ffffff"
  panel: "#faf7f0"
  ink: "#16201d"
  ink-2: "#55605b"
  rule: "#e4ddcf"
  rule-strong: "#cfc6b3"
  well: "#f1ebdd"
  hover: "#faf6ec"
  accent: "#8f6b1f"
  accent-fg: "#ffffff"
  accent-soft: "#f4ecd9"
  side: "#14342b"
  side-ink: "#f3eee2"
  side-ink-2: "#c3cfc7"
  side-rule: "#22493c"
  side-sel: "#22503f"
  side-hover: "#1b4135"
  mention: "#b42318"
  mention-bg: "#fcebe8"
  badge: "#b42318"
  online: "#2f8a5b"
  away: "#b08420"
  # Dark theme roles (.dark)
  sheet-dark: "#111c18"
  panel-dark: "#14221d"
  ink-dark: "#ece8dd"
  ink-2-dark: "#a9b5ae"
  rule-dark: "#24352e"
  rule-strong-dark: "#34483f"
  well-dark: "#1b2b25"
  hover-dark: "#16251f"
  accent-dark: "#c9a24b"
  accent-fg-dark: "#1b1507"
  accent-soft-dark: "#2a2a1c"
  side-dark: "#0f231d"
  side-ink-dark: "#ece8dd"
  side-ink-2-dark: "#a9b5ae"
  side-rule-dark: "#1e3a30"
  side-sel-dark: "#1d3d32"
  side-hover-dark: "#173129"
  mention-dark: "#ff8a80"
  mention-bg-dark: "#3a1f1d"
  badge-dark: "#d93a2b"
  online-dark: "#5cc48d"
  away-dark: "#d9a93a"
  # Avatar tints (both themes; initials in #1e2b26)
  avatar-1: "#e3d9c4"
  avatar-2: "#d4e0d9"
  avatar-3: "#e6d6d0"
  avatar-4: "#d9dce6"
  avatar-5: "#dfe3cf"
typography:
  statement:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.015em"
  record-title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "-0.01em"
  message:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  ui:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: "18px"
  speaker:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "18px"
  meta:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    fontFeature: "tnum"
  label:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: "16px"
  badge:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "18px"
    fontFeature: "tnum"
  record-figure:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: "20px"
  record-value:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  code:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  hairline: "4px"
  chip: "6px"
  row: "7px"
  control: "8px"
  frame: "10px"
  card-phone: "12px"
  pill: "14px"
  sheet: "20px"
  field-phone: "22px"
  full: "9999px"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "32": "32px"
  speaker-margin: "152px"
  speaker-margin-panel: "96px"
  margin-gap: "20px"
  margin-gap-panel: "14px"
  rail: "64px"
  sidebar: "256px"
  panel: "400px"
  header: "56px"
components:
  sidebar-row:
    textColor: "{colors.side-ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.row}"
    padding: "0 8px"
    height: "30px"
  sidebar-row-unread:
    textColor: "{colors.side-ink}"
  sidebar-row-selected:
    backgroundColor: "{colors.side-sel}"
    textColor: "{colors.side-ink}"
  badge:
    backgroundColor: "{colors.badge}"
    textColor: "#ffffff"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "0 6px"
    height: "18px"
    width: "min 20px"
  governance-chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
    padding: "0 10px"
    height: "28px"
  icon-button:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    size: "32px"
  icon-button-on:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  button:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "0 12px"
    height: "32px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.row}"
    padding: "0 12px"
    height: "32px"
  button-primary-large:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.frame}"
    height: "44px"
    width: "380px"
  composer:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-2}"
    typography: "{typography.message}"
    rounded: "{rounded.frame}"
    padding: "6px 6px 6px 14px"
  send-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.control}"
    size: "34px"
  title-block:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.frame}"
  title-block-cell:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    padding: "8px 12px 9px"
  mention-chip:
    backgroundColor: "{colors.mention-bg}"
    textColor: "{colors.mention}"
    rounded: "{rounded.hairline}"
    padding: "0 4px"
  person-chip:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline}"
    padding: "0 4px"
  reaction:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "28px"
  reaction-mine:
    backgroundColor: "{colors.accent-soft}"
  board-header:
    backgroundColor: "{colors.forest}"
    textColor: "{colors.bone}"
    height: "40px"
  board-row:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    padding: "10px 0"
    height: "min 62px"
  board-row-lit:
    backgroundColor: "{colors.well}"
  phone-inbox-row:
    backgroundColor: "{colors.sheet}"
    padding: "12px 16px"
  phone-inbox-row-lit:
    backgroundColor: "{colors.well}"
  phone-tap:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.frame}"
    size: "44px"
  sheet-option:
    textColor: "{colors.ink}"
    typography: "{typography.message}"
    padding: "0 22px"
    height: "52px"
---

# Design System: Cenacle

## Overview

**Creative North Star: "The Minutes"**

A conversation is a record. Every message is laid out like a line in the minutes of an assembly: who spoke and when stands in a right-aligned margin column, and the words run beside it in a calm measure. The working screen carries the identity itself: warm Paper and Bone neutrals in the work area, a Forest sidebar with Bone text, Forest-tinted near-black ink, and a Night-tinted dark theme. The brand is present all day, not only on the sign-in page.

The world is flat and ruled. Depth comes from hairline rules and tonal panels (white sheet, Paper panel, Bone-tinted well), never from cards floating on shadows. There is exactly one shadow in the product UI, for popovers. Three record-like devices carry the system: the speaker margin in messages and threads, the title block that states a channel's governance (owner, members, classification, retention) as editable cells, and the Inbox board that lists what needs you like a departures board, with changed rows lit until seen.

Colour does jobs, not decoration. Brass marks only where the person acts (selection, focus, send). Red belongs only to the person's own mentions, errors and destructive actions. Everything else is ink, rules and weight. Density is desktop-first and calm; on phones the margin folds above the text and every target grows to 44px.

**Key Characteristics:**
- Speaker margin: 152px right-aligned name + time column with a 24px avatar at its inner edge; 96px in side panels; folded above the text on phones.
- Paper world: white sheet, Paper panel, Bone-tinted well; Forest sidebar; Night-tinted dark theme.
- Brass only for selection, focus and send; red only for the user's mentions, errors and destructive actions.
- Hairline rules (1px) and 10px-radius frames instead of shadows; one popover shadow.
- Geist throughout, Geist Mono for record values and figures (times, IDs, counts, dates).

## Colors

A warm paper-and-forest palette with one restrained metal accent and one reserved alarm colour. Values are in the frontmatter; light roles are the `:root` set, dark roles the `-dark` set (`.dark` in the build).

### Primary
- **Brass-ink** (`brass-ink`, light accent) / **Brass** (`brass`, dark accent): selection, focus and the primary action only. Selected sidebar row icon, active tab underline, focused composer border and ring, send button, primary buttons, the reaction you added, the active workspace ring in the rail. Its soft form (`accent-soft`) is the selected-control and focus-ring fill.

### Secondary
- **Forest** (`forest`): the sidebar ground in light, and the Inbox board's header row (Bone text). It is the identity surface, not a status colour.
- **Night** (`night`): the workspace rail in both themes; base of the dark theme tints.

### Tertiary
- **Mention Red** (`mention`, `mention-bg`, `badge`): only the person's own mentions (the "@ " mark in the margin, the red time, the "@you" chip), numbered badges, errors and destructive actions.

### Neutral
- **Sheet** (`sheet`): the work area (message list, Inbox board, composer field, title block).
- **Paper / Panel** (`paper`, `panel`): right panels (channel details, thread) and Inbox group headers.
- **Well** (`well`): Bone-tinted fill for code, file icons, other people's mention chips, the classification chip, and the lit (changed, unseen) Inbox row.
- **Hover** (`hover`): hovered message turn.
- **Ink** (`ink`): text and the "New" divider line. **Ink-2** (`ink-2`): secondary text (times, topic, meta, placeholders, labels).
- **Rule** (`rule`): hairlines between rows and regions. **Rule-strong** (`rule-strong`): frames of controls and containers (composer, buttons, governance chip, board, title block, reactions).
- **Side ink** (`side-ink`, `side-ink-2`), **side rule**, **side selection** and **side hover**: the sidebar's own neutral set on Forest.
- **Presence** (`online`, `away`): presence dots only; away is a ring, online a filled dot, so state is not carried by hue alone.
- **Avatar tints** (`avatar-1` … `avatar-5`): quiet paper-world tints behind initials (#1e2b26).

### Named Rules
**The Brass Is a Hand Rule.** Brass/Brass-ink appears only where the person is acting: selection, focus, send (and primary buttons). It never means new, unread, thread or someone else's mention.

**The Red Is Yours Rule.** Red is reserved for the person's own mentions, errors and destructive actions. Other people's mentions are a neutral `well` chip; the "New" divider is an ink line; reply counts use weight.

**The Brand Is Not Status Rule.** Forest, Brass, Paper, Night and Bone never signal state (online, error, warning, success).

## Typography

**Display Font:** Geist (with system-ui, sans-serif)
**Body Font:** Geist (with system-ui, sans-serif)
**Label/Mono Font:** Geist Mono (with ui-monospace, monospace), for record values and figures only

**Character:** One sans family carries the whole record, from minutes text to headlines; Geist Mono appears where a value is a fact to be read precisely (times on the Inbox board, record IDs, member counts, dates, code). Numbers in lists are tabular everywhere.

### Hierarchy
- **Statement** (600, 40px, 1.15, -0.02em): sign-in brand panel only.
- **Headline** (600, 24px, 32px, -0.015em): page titles such as Inbox. Sign-in heading uses 28px/1.2.
- **Record title** (600, 22px, 28px): the channel name cell of the title block.
- **Title** (600, 17px, -0.01em): channel header name. Panel headers 15px/600; phone header 16px/600.
- **Message** (400, 15px, 1.55, max 72ch): message text. 14.5px in side panels, 16px on phones.
- **Body** (400, 14px, 20px): base UI text, sidebar rows, panel paragraphs.
- **UI** (400–600, 13.5px, 18px): topic, tabs, panel rows, title-block values, file names.
- **Speaker** (600, 13px, 18px): names in the speaker margin; buttons and thread summaries share 13px.
- **Meta** (400, 12px, 16px, tabular): times, counts, sidebar meta, sub-labels. Section headers in the sidebar and the governance chip use 12.5px.
- **Label** (400, 11.5px, 16px): title-block cell labels.
- **Badge** (600, 11px, 18px, tabular): numbered badges; avatar initials are 11px/600 (12px at 32px avatars).
- **Record figure** (Geist Mono 500, 15px, 20px): Inbox board times (14px on the phone Inbox).
- **Record value / code** (Geist Mono 400, 13px): title-block numbers and dates, inline code and code blocks (1.6 line height); record IDs 12px.

### Named Rules
**The Fact in Mono Rule.** Geist Mono only for values that are records (time on the board, IDs, counts, dates, code); never for labels, headings or prose.

**The No Small Initials Rule.** Avatars are at least 24px with initials at least 11px.

## Layout

Desktop shell is a four-column grid: rail 64px | sidebar 256px | main (minmax(0, 1fr)) | optional right panel 400px. Rail, sidebar header, main header and panel header align on a 56px band. The channel header sits above a 40px tab strip.

**The speaker margin** is the core grid of every conversation: a two-column grid of 152px margin + 20px gap + text (max 72ch). The margin holds the name (13px/600) and time (12px) right-aligned, with the 24px avatar at its inner edge. Day headings, the "New" divider and the typing line reuse the same columns, and the composer starts at the text column (margin-left 152px + 20px). In right panels the margin is 96px with a 14px gap and the composer spans full width. Continuation turns hide the time until hover. On phones (390px reference width) the margin collapses: name and time sit on one baseline line above the text, 16px side gutters.

Spacing rhythm is a 2/4-based scale (2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32). Main content gutters are 24px (32px on the Inbox page, 20px in panels, 16px on phones). Message turns pad 6px vertically; day headings 16px above.

The Inbox board is a six-column table: Time 72px | Where 188px | From 168px | What (flex) | Status 104px | Actions 176px, cell padding 0 12px, rows at least 62px tall.

No breakpoints are defined in the build; the phone layout is a separate composition at 390 x 844.

### Named Rules
**The Margin Holds the Who Rule.** Speaker identity and time always live in the margin column (or the line above on phones), never inside a bubble with the text.

## Elevation & Depth

Flat and ruled. Depth is tonal (sheet, panel, well) and linear (1px rules), never lifted. The one product shadow is the popover shadow, used by the message hover toolbar and other floating menus. The phone action sheet carries its own bottom-sheet shadow over a Night scrim (rgba(12, 26, 22, .45)). Focus is a 3px `accent-soft` ring plus an accent border, not a shadow.

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 6px 20px rgba(20, 52, 43, .10), 0 0 0 1px rgba(20, 52, 43, .10)`; dark `0 8px 24px rgba(0, 0, 0, .45), 0 0 0 1px #34483f`): hover toolbars, menus, popovers.
- **Bottom sheet** (`box-shadow: 0 -10px 30px rgba(0,0,0,.25)`): phone action sheet only.

### Named Rules
**The One Shadow Rule.** Nothing at rest casts a shadow. Only floating layers (popover, phone sheet) do.

## Shapes

Softly squared. Controls use 7–8px corners, frames and containers 10px, inline chips 4px, reactions and badges are pills, avatars and presence dots are circles. Phone controls round further (44px round buttons, 22px-radius field, 20px sheet top corners, 12px preview card).

Frames and containers (composer, Inbox board, title block, buttons, governance chip, file card, pinned card) use a 1px `rule` or `rule-strong` border with a 10px radius (8px for small cards, 6–7px for buttons and chips). Never a heavy ink border.

### Named Rules
**The Hairline Frame Rule.** Frames and containers use 1px `rule`/`rule-strong` with a 10px radius; never a thick or ink-coloured frame. Status is never a coloured side stripe.

## Components

### Buttons
- **Shape:** gently squared (7px), 32px high, 0 12px padding, 13px/500.
- **Default:** `sheet` fill, 1px `rule-strong` border, ink text.
- **Primary:** `accent` fill and border, `accent-fg` text. The sign-in primary is 44px high, 10px radius, 15px/600.
- **Icon button:** 32px square, 8px radius, `ink-2` icon (18px lucide, stroke 1.75); "on" state (open panel) is `accent-soft` fill with accent icon.
- **Send:** 34px square, 8px radius, accent fill; on phones a 44px circle.

### Chips
- **Governance chip:** 28px high, 0 10px, 1px `rule-strong`, 6px radius, 12.5px ink text with a shield icon in `ink-2`: "Internal · kept 2 years". Opens channel details.
- **Classification chip** (in the title block): filled `well`, 4px radius, 1px 7px padding, 12px/600, no border.
- **Person chip:** other people's mentions in text, `well` fill, 600, 4px radius. **Your mention chip:** `mention-bg` fill, `mention` text.
- **Reaction:** 28px pill (14px radius), 1px `rule-strong`, 13px/500; yours uses `accent` border and `accent-soft` fill.

### Badges
- 18px high, min 20px wide, 9px radius, `badge` fill, white 11px/600 tabular. Only for mentions and direct messages (Inbox badge = mentions + DMs). Other unread states use a 7px dot in current text colour, bold row text, or a text meta ("New replies", "4 open").

### Navigation (sidebar)
- **Row:** 30px high, 0 8px padding, 10px gap, 7px radius, 18px icon, 14px text in `side-ink-2`.
- **Unread:** `side-ink`, 600. **Selected:** `side-sel` fill, `side-ink`, 600, icon in Brass.
- **Section header:** 12.5px/600 `side-ink-2`, 14px top padding. **Jump to:** 32px field, 1px `side-rule`, 8px radius, Ctrl K in mono.
- **Rail:** 64px Night column, 40px workspace tiles (10px radius); the active one is Forest with a 2px Night + 2px Brass ring.
- Drafts show a pen icon + "Draft"; connection state is a quiet 6px dot + "Connected".

### Speaker-margin turn (signature)
- Grid 152px | 20px gap | text; padding 6px 8px 6px 0; 8px radius for the hover fill (`hover`).
- Margin: name 13px/600 over time 12px `ink-2` tabular, right-aligned, 8px gap to the 24px avatar.
- Continuation: no name, time hidden until hover. Sending: text in `ink-2`, time reads "· sending".
- **Mention of you:** the margin carries the mark: a red "@ " before the name and the time in `mention`, 600. No band, no side stripe.
- Hover toolbar: popover shadow, 3px padding, 30px icon buttons, offset -16px above the turn's top right.
- Thread summary: 28px line, stacked 24px avatars, "4 replies" in ink 600 and "last reply" in `ink-2`; the open thread gets an `accent-soft` fill (selection).
- "New" divider: label in the margin (12px/600), 1px ink line in the text column.

### Composer
- Field starts at the text column; 1px `rule-strong`, 10px radius, padding 6px 6px 6px 14px, placeholder 15px `ink-2`.
- Exactly five controls: attach, Aa (formatting toggle), emoji, mention, send. The formatting row lives behind Aa. Threads drop mention (four controls).
- Focus: `accent` border + `0 0 0 3px accent-soft` ring.
- Typing / sending / draft status line above it: 24px, 12.5px `ink-2`, in the text column.

### Title block (channel details)
- Two-column grid inside a 1px `rule-strong` frame, 10px radius, `sheet` fill, internal 1px `rule-strong` cell dividers.
- First cell spans both columns: label "Channel", value 22px/600.
- Cells: 8px 12px 9px padding; label 11.5px `ink-2`, value 13.5px/18px (numbers and dates in Geist Mono 13px).
- Editable cells (Owner, Classification, Retention) are buttons with a 16px pencil at the right edge, vertically centered across label and value.
- A full-width note row (12.5px `ink-2`) explains the retention consequence.

### Inbox board (signature)
- Container: 1px `rule-strong`, 10px radius, `sheet` fill.
- Header row: 40px Forest band (dark theme `side-sel-dark`), Bone 13px/500 text.
- Group row: 34px, `panel` fill, 1px `rule` top, 13px/600 + `ink-2` count.
- Row: min 62px, 10px vertical padding, 1px `rule` top. Time in Geist Mono 15px/500; Where with icon + 12px sub-label; From with 24px avatar; What clamps to two lines; Status 13px; Actions are 28px buttons (6px radius), the primary one in accent.
- **Lit row:** changed and unseen rows take the `well` fill until opened. Seen rows drop to weight 400. Moved rows show a 14px arrow + "moved". No coloured side stripe.

### Phone
- 44px targets everywhere (header taps, round buttons, tabs at 44px).
- Header 52px with back (+ badge), title 16px/600 and a 12px governance sub-line.
- Composer: 44px pill field (22px radius, 16px text) between round attach/emoji buttons and a round accent send.
- **Action sheet:** 20px top radius, 36 x 5px grab handle, a `well` message preview (12px radius), 52px option rows (16px, 1px `rule` top), then a row of 48px quick reactions. Actions first, reactions below.
- **Inbox row:** grid 52px time | content | 44px overflow (⋯) button for Done and Later (swipe as alternative); 12px 16px padding, 1px `rule` bottom; time Geist Mono 14px/500; lit rows use `well`.

### Sign-in
- Two halves: Forest brand panel (logo once, 40px statement, small host/version line) and a sheet form column with the 44px primary "Continue with Cenacle ID" and 32px secondary buttons for theme, language and help.

## Do's and Don'ts

### Do:
- **Do** put who and when in the speaker margin (152px desktop, 96px panels, above the text on phones).
- **Do** use Brass-ink (light) / Brass (dark) only for selection, focus, send and primary buttons.
- **Do** keep red for the user's own mentions, errors and destructive actions; mark your mention in the margin ("@ " + red time) and with the `mention-bg` chip.
- **Do** frame containers with 1px `rule`/`rule-strong` and a 10px radius.
- **Do** keep every text at 4.5:1 or more on its own surface (secondary `ink-2` is 6.5:1 on sheet, 5.5:1 on well in light; 8.2:1 / 7.0:1 in dark).
- **Do** size targets at 24px minimum, 28–32px for fine pointers, 44px on touch; every hover action also has a non-hover path (⋯ button, long-press sheet).
- **Do** use Geist Mono and tabular numerals for record values.

### Don't:
- **Don't** use numbered badges for anything except mentions and direct messages.
- **Don't** use coloured side stripes, full-width coloured bands or tinted cards to signal state; use weight, the `well` fill or a text label.
- **Don't** draw thick or ink-coloured frames; no heavy ink border anywhere.
- **Don't** add shadows to resting surfaces; only popovers and the phone sheet float.
- **Don't** use Brass for new, unread, thread or other people's mentions.
- **Don't** put the composer's formatting row on screen by default; five controls, formatting behind Aa.
- **Don't** repeat the logo arch as ornament; the logo appears once per screen.
