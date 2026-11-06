# Accessibility Conformance Report

## Calls extension — source review only

The new call interface has not undergone runtime accessibility evaluation in this
editing environment. The earlier product assessment below must not be interpreted
as verification of calls. Keyboard/focus, screen readers, device dialogs, reflow,
contrast and touch targets require the operator's browser/device checks.

**WCAG 1.2.4 Captions (Live): Does not support.** Calls have no live captions or
transcription. This is an explicit product limitation. Speaking is also indicated
by text, and device controls expose names/pressed states. Native desktop consent
and source-menu accessibility still require platform verification.

Cenacle 0.41.0, based on the VPAT® 2.5 Rev INT template (WCAG 2.2 and EN 301 549).

|             |                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Product     | Cenacle: the web app, the desktop app (Windows, Linux), Cenacle ID's sign-in and account pages |
| Version     | 0.41.0                                                                                         |
| Report date | 2026-10-25                                                                                     |
| Contact     | The project's issue tracker (label `accessibility`); see [the statement](statement.md)         |
| Standards   | WCAG 2.2 levels A and AA; EN 301 549 V3.2.1 (2021-03), chapters 4, 5, 9, 11, 12                |
| Not covered | The mobile app (a preview until 1.1) and the project website                                   |

## How it was evaluated

- **Automated, on every change (CI):** axe-core (rules of WCAG 2.0–2.2 A/AA, with
  `target-size`) on the sign-in pages, the app shell, dialogs, settings, files, search,
  threads, workflows and the component gallery, in light and dark themes and both
  densities; target sizes of every control (at least 24 px with a mouse, 44 px on touch
  screens); Cenacle ID's pages with axe as well.
- **Manual checks written as tests** (`web/e2e/accessibility.spec.ts`): a way past the
  navigation (skip link), keyboard-only sending, focus shown and not covered at every Tab
  stop and no keyboard trap, focus moved into dialogs and returned, reflow at 320 CSS px,
  raised text spacing, reduced motion, forced colors, announcements of new messages.
- **Keyboard pass (0.99.1):** every focus stop of a channel, Settings and the quick
  switcher, in English and Turkish, read from the browser's accessibility tree, and new
  messages from others checked in the announcements. It found focus falling to the page when
  the message list dropped the focused message (fixed and tested in 0.99.1). An attempt to
  drive Orca itself on a virtual display did not get keyboard events through to it.
- **Not yet done:** a full session with screen readers (NVDA, JAWS, VoiceOver, Orca) by
  people who use them every day. Results that depend on what a screen reader says are
  based on the accessibility tree the tests read. This is the main gap.

Terms: **Supports**, **Partially supports** (some parts do not meet the criterion),
**Does not support**, **Not applicable**.

## WCAG 2.2 — Level A

| Criterion                                     | Level              | Remarks                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1 Non-text content                        | Partially supports | Icons and controls have names; avatars and decorations are hidden from assistive technology. Images people upload are described by their file name only: there is no field for a description yet.        |
| 1.2.1 Audio-only and video-only (prerecorded) | Partially supports | The interface has no media of its own. Voice messages people record have no transcript.                                                                                                                  |
| 1.2.2 Captions (prerecorded)                  | Partially supports | Video clips people record have no captions.                                                                                                                                                              |
| 1.2.3 Audio description or media alternative  | Not applicable     | No prerecorded media in the product itself.                                                                                                                                                              |
| 1.3.1 Info and relationships                  | Supports           | Landmarks (navigation, main, complementary), headings, lists, tables, form labels and the message log are in the markup.                                                                                 |
| 1.3.2 Meaningful sequence                     | Supports           | The reading order follows the visual order; panels are in the DOM in their visual order.                                                                                                                 |
| 1.3.3 Sensory characteristics                 | Supports           | Instructions do not depend on shape, place or sound alone.                                                                                                                                               |
| 2.1.1 Keyboard                                | Supports           | Every function has a keyboard path: resizing panels (arrow keys on the handles), reordering the sidebar (move commands), menus, dialogs, the composer. Tested: sending a message with the keyboard only. |
| 2.1.2 No keyboard trap                        | Supports           | Tested: Tab goes through the whole page and comes back around. Dialogs close with Escape.                                                                                                                |
| 2.1.4 Character key shortcuts                 | Supports           | Shortcuts use a modifier key (Ctrl, Alt) or only work in the focused message box.                                                                                                                        |
| 2.2.1 Timing adjustable                       | Supports           | No time limits on reading or writing; undo toasts stay at least 10 seconds. Sessions last until sign-out unless an administrator sets a limit.                                                           |
| 2.2.2 Pause, stop, hide                       | Supports           | Nothing moves for more than five seconds; animated profile pictures show their first frame when reduced motion is set.                                                                                   |
| 2.3.1 Three flashes or below                  | Supports           | Nothing flashes.                                                                                                                                                                                         |
| 2.4.1 Bypass blocks                           | Supports           | A skip link is the first Tab stop ("Skip to the message box"); landmarks.                                                                                                                                |
| 2.4.2 Page titled                             | Supports           | The tab's title names the channel or view and the workspace.                                                                                                                                             |
| 2.4.3 Focus order                             | Supports           | Tested: focus moves into a dialog and back to the control that opened it, and stays in the message list when the list drops the focused message (0.99.1).                                                |
| 2.4.4 Link purpose (in context)               | Supports           | Links have their text or a name; message links show their address.                                                                                                                                       |
| 2.5.1 Pointer gestures                        | Supports           | No path-based or multipoint gestures are needed.                                                                                                                                                         |
| 2.5.2 Pointer cancellation                    | Supports           | Actions happen on release (native click).                                                                                                                                                                |
| 2.5.3 Label in name                           | Supports           | Visible labels are part of the accessible names.                                                                                                                                                         |
| 2.5.4 Motion actuation                        | Not applicable     | No function works by moving the device.                                                                                                                                                                  |
| 3.1.1 Language of page                        | Supports           | `lang` follows the interface language (English, Turkish).                                                                                                                                                |
| 3.2.1 On focus                                | Supports           | Focus does not change context.                                                                                                                                                                           |
| 3.2.2 On input                                | Supports           | Settings change only what they name; nothing navigates on input.                                                                                                                                         |
| 3.2.6 Consistent help                         | Supports           | The keyboard shortcuts (Ctrl+/) and settings are reached the same way on every page.                                                                                                                     |
| 3.3.1 Error identification                    | Supports           | Errors say what went wrong in text next to the field and as an alert.                                                                                                                                    |
| 3.3.2 Labels or instructions                  | Supports           | Fields have labels; formats are explained (e.g. the recovery key).                                                                                                                                       |
| 3.3.7 Redundant entry                         | Supports           | Nothing asks for the same information twice in a process.                                                                                                                                                |
| 4.1.2 Name, role, value                       | Supports           | Base UI primitives give roles and states; checked in the accessibility tree by the tests (not yet with screen readers, see above).                                                                       |

## WCAG 2.2 — Level AA

| Criterion                                       | Level              | Remarks                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2.4 Captions (live)                           | Not applicable     | No live media yet; voice and video calls come with 1.0.                                                                                                                                  |
| 1.2.5 Audio description (prerecorded)           | Not applicable     | No prerecorded media in the product itself.                                                                                                                                              |
| 1.3.4 Orientation                               | Supports           | Works in portrait and landscape.                                                                                                                                                         |
| 1.3.5 Identify input purpose                    | Supports           | Sign-in fields carry `autocomplete` (username, current-password, one-time-code, name).                                                                                                   |
| 1.4.3 Contrast (minimum)                        | Partially supports | The built-in themes are checked by axe in light and dark and both densities. Custom theme colors that administrators or people choose are not checked.                                   |
| 1.4.4 Resize text                               | Supports           | Text scales with the browser to 200% without loss.                                                                                                                                       |
| 1.4.5 Images of text                            | Supports           | No images of text (the logo excepted).                                                                                                                                                   |
| 1.4.10 Reflow                                   | Supports           | Tested at 320 CSS pixels: no sideways scrolling; panels become sheets.                                                                                                                   |
| 1.4.11 Non-text contrast                        | Supports           | Control borders and focus rings use tokens chosen for at least 3:1 in both built-in themes (not measured by a tool); in forced colors nothing opts out of the system colors (tested).    |
| 1.4.12 Text spacing                             | Supports           | Tested with the spacing of the criterion: no clipped text, no sideways scrolling.                                                                                                        |
| 1.4.13 Content on hover or focus                | Supports           | Tooltips and hover cards can be dismissed with Escape, stay while hovered and are never the only way to an action.                                                                       |
| 2.4.5 Multiple ways                             | Supports           | The sidebar, search, the quick switcher (Ctrl+K) and links.                                                                                                                              |
| 2.4.6 Headings and labels                       | Supports           | Headings name their areas; labels name their fields.                                                                                                                                     |
| 2.4.7 Focus visible                             | Supports           | Tested: every Tab stop shows its focus.                                                                                                                                                  |
| 2.4.11 Focus not obscured (minimum)             | Supports           | Tested: no Tab stop is covered by sticky parts.                                                                                                                                          |
| 2.5.7 Dragging movements                        | Supports           | Panels resize by keyboard and with a button; sidebar items move with menu commands; files are chosen with a button as well as dropped.                                                   |
| 2.5.8 Target size (minimum)                     | Supports           | Tested: every control at least 24 × 24 px (44 px on touch screens).                                                                                                                      |
| 3.1.2 Language of parts                         | Partially supports | The interface is marked; messages people write in another language are not.                                                                                                              |
| 3.2.3 Consistent navigation                     | Supports           | The rail, sidebar and header are the same on every page.                                                                                                                                 |
| 3.2.4 Consistent identification                 | Supports           | The same functions have the same names and icons throughout ([glossary](../ux/glossary.md)).                                                                                             |
| 3.3.3 Error suggestion                          | Supports           | Errors say how to correct them.                                                                                                                                                          |
| 3.3.4 Error prevention (legal, financial, data) | Supports           | Destructive actions are confirmed, the most serious by typing the name; deletions can be undone for five minutes.                                                                        |
| 3.3.8 Accessible authentication (minimum)       | Supports           | Passwords and codes can be pasted and filled by password managers; passkeys are offered when the administrator allows them. The two-step code is read from an app, which may fill it in. |
| 4.1.3 Status messages                           | Supports           | Toasts, typing notices and new messages from others are announced (`role="status"`); the message list does not read out older messages loaded while scrolling (tested).                  |

4.1.1 Parsing was removed from WCAG 2.2 and is always satisfied.

## EN 301 549

| Clause                                                          | Remarks                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.2 Functional performance statements                           | Use without vision depends on screen readers (see the gap above); use with limited vision: zoom, reflow, both themes, forced colors; without perception of color: meaning never by color alone; with limited manipulation: keyboard, large targets, no timing; with limited cognition: plain language, undo, confirmation of destructive actions.                                                |
| 5.2 Activation of accessibility features                        | The platform's features (zoom, high contrast, reduced motion) are followed.                                                                                                                                                                                                                                                                                                                      |
| 5.3 Biometrics                                                  | Passkeys may use biometrics; a password with a code always works too.                                                                                                                                                                                                                                                                                                                            |
| 5.4 Preservation of accessibility information during conversion | Exports keep text and structure (Markdown, JSON).                                                                                                                                                                                                                                                                                                                                                |
| 9 Web                                                           | As WCAG 2.2 A/AA above (9.1–9.4 map to the WCAG 2.1 criteria, all listed).                                                                                                                                                                                                                                                                                                                       |
| 10 Non-web documents                                            | Not applicable: the product makes no documents (exports are data).                                                                                                                                                                                                                                                                                                                               |
| 11 Software (desktop app)                                       | The desktop app shows the same web app in Chromium (Electron), which exposes it to the platform's accessibility services (11.5.2): the WCAG results above apply. 11.7 User preferences: the system's theme, contrast and motion settings are followed. 11.8 Authoring tools: the composer keeps Markdown structure (headings, lists, links); it does not ask for image descriptions (see 1.1.1). |
| 12.1 Product documentation                                      | The documentation (`docs/`) is plain Markdown with headings, lists and tables.                                                                                                                                                                                                                                                                                                                   |
| 12.2 Support services                                           | Questions and problems are taken in the issue tracker, in text.                                                                                                                                                                                                                                                                                                                                  |

## Known limitations

1. No session yet with people who use screen readers every day.
2. Custom theme colors are not checked for contrast.
3. Uploaded images have no description field.
4. Voice messages and video clips have no transcript or captions.
5. Messages are not marked with their language.

Each of these is tracked for a later release; the [statement](statement.md) is updated with
every report.
