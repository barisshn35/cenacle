# 0027. Channel tabs: canvases and lists (v0.22)

- Status: accepted
- Date: 2026-10-22

## Context

Conversations scroll away. Teams keep what stays true somewhere next to the channel: a page
of notes and decisions, a list of things to do, a board of who does what, a link to the
runbook. Enterprise chat products show these as tabs of a channel. Cenacle does the same,
inside the channel's own access rules.

## Decisions

1. **A channel has up to 20 tabs** after its messages: a **canvas**, a **list** or a
   **link**. Tabs belong to the channel: its members see them, people who can post add,
   rename and reorder them, and only who added a tab or the channel's managers delete it.
   Deleting a canvas or list tab deletes its content (confirmed, and audited).
2. **A canvas is Markdown** (up to 50,000 characters), shown like messages but with real
   headings. It is **edited by one person at a time**: editing takes a two-minute turn,
   renewed every minute while the editor is open; saving or cancelling gives it back, and
   an abandoned turn expires. Saves name the version they were edited from; a save over a
   newer version is refused (`canvas_changed`) and the editor copies the writer's text to
   the clipboard before loading the other version. Real-time co-editing (CRDTs) is left for
   later: it needs a Go implementation we can trust and maintain.
3. **A list has typed columns** (up to 20): text, number, choice, status (to do, in progress,
   done; at most one), person, date, checkbox. Values are checked by the server (a person
   must be a member of the workspace). A list with a status or choice column can be shown
   as a **board** grouped by it. Rows (up to 2,000) are ordered by a fractional position;
   when two rows leave no room between them, the list is numbered again in the same
   transaction.
4. **Tasks are list rows**: a row's person columns, status and first date column are copied
   into indexed columns (`assignees`, `done`, `due`), so "assigned to me" is one query. The
   **Tasks** view shows a person's open approvals and forms of workflows, then the rows
   assigned to them, the soonest due first. A "Task list" tab is a list made with status,
   assignee and due date columns, named in the person's language by the client.
5. **Real time:** `tabs.changed`, `canvas.updated` (with the canvas) and `list.changed` go to
   the channel's members.
6. **Accessibility:** tabs are links (`aria-current`), cards move between board columns with
   a "Move to" menu as well as by dragging (WCAG 2.5.7), table cells are labelled with their
   column and row.

## Consequences

- No new service: tabs, canvases and lists are PostgreSQL tables of the chat server.
- Search does not index canvases and lists yet.
