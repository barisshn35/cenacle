# 0007. Channel and message management (v0.5)

- Status: accepted
- Date: 2026-10-21

## Context

v0.5 lets people correct and remove messages and lets managers organize channels:
rename, archive, categories, and a fast way to jump between channels.

## Decisions

1. **Editing.** Only the author edits a message; it is marked as edited (`edited_at`) and
   members receive `message.updated`. Messages in archived channels cannot be edited.
2. **Deleting with undo.** The author or a channel manager deletes a message (managers
   moderate). Deletion is soft for 5 minutes: the message disappears for everyone
   (`message.deleted`), the person who deleted it can restore it ("Undo",
   `POST …/restore`, members get `message.created` again), and a background job then
   removes it for good. A confirmation dialog would slow down a frequent, reversible
   action (UX plan: undo over confirm).
3. **Archiving instead of deleting channels.** Archived channels are read-only, leave the
   sidebar and stay readable for their members (directory, links); managers unarchive them.
   Archiving asks for confirmation (S2) and offers Undo. Mandatory channels cannot be
   archived. Deleting channels for good is left to the admin console (v0.14).
4. **Renaming.** Managers rename channels (names stay unique regardless of case). The
   channels of the installation settings keep their names (`403 channel_configured`): the
   server would create them again at the next start.
5. **Categories are shared.** Categories group channels in everyone's sidebar, in an order
   the administrator sets (move up/down buttons, no dragging needed; WCAG 2.5.7). Deleting a
   category keeps its channels, without category. Personal sections can follow later.
6. **Quick switcher without a new dependency.** Ctrl/⌘+K opens a combobox (ARIA 1.2: focus
   stays in the input, `aria-activedescendant`) listing the user's channels first, then
   public ones; matching ignores case and accents ("genel" finds "Genel", "ç" finds "c").
   `cmdk` was the kickoff's suggestion but brings Radix primitives; the small component
   keeps the single Base UI primitive layer.
7. **Message actions are reachable without hover.** The actions button shows on hover and
   on keyboard focus, and always on touch screens (`pointer: coarse`).

## Consequences

- Deleted messages stay in the database for up to 5 minutes; backups taken in that window
  contain them.
- Category changes reach everyone at once (`categories.changed`).
