# Accessibility statement

Cenacle aims to be usable by everyone in an organization: with a keyboard, a screen
reader, magnification, high contrast, on a phone or with limited time and attention.

## Conformance status

Cenacle 1.0 **partially conforms** to WCAG 2.2 level AA and to the matching clauses of
EN 301 549 V3.2.1: most criteria are met; the exceptions are listed below and in the
[conformance report](conformance-report.md).

## What works

- Everything can be done with a keyboard; a skip link leads past the navigation.
- Focus is always visible and never hidden behind other parts.
- The app reflows down to 320 pixels, follows the browser's text size, spacing, the
  system's theme, high-contrast mode and reduced-motion setting.
- Every control is at least 24 pixels (44 on touch screens); dragging always has another
  way.
- New messages from others are announced to screen readers, briefly, one at a time.
- Destructive actions are confirmed and can be undone.
- Calls can have live captions in English and Turkish, and screen readers are told when
  someone raises a hand or reacts.

## Known limitations

- The app has not yet been tested in a full session with screen readers.
- Custom theme colors are not checked for contrast.
- Images people upload have no description, only their file name.
- Voice messages, video clips and call recordings have no transcript or captions.
- A line of live captions in a call stays eight seconds.
- Messages written in another language are not marked as such.

## How it is checked

Automated checks (axe-core, target sizes) and keyboard, focus, reflow, spacing, motion and
announcement tests run on every change; see [the report](conformance-report.md) for the
method.

## Feedback

Tell us about barriers in the project's issue tracker with the label `accessibility`, or
through your organization's administrator, who can pass them on.

## Date

Prepared on 2026-10-25 for 0.41.0 and reviewed on 2026-11-13 for 1.0; reviewed with every release that changes the
interface.
