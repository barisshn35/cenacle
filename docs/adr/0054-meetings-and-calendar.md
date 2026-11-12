# ADR 0054: Meetings and calendar

Status: accepted (2026-11-12).

## Context

People plan calls ahead: a weekly review, an interview, a one-off talk. Until now
a call could only start at once. Teams kept the plan elsewhere (a calendar
server, a mail client) and copied the link by hand. Cenacle is self-hosted and
must work without any outside service; many installations have SMTP and people's
calendars live in their mail clients.

## Decision

- **A meeting belongs to a place**: a channel or conversation where its call
  happens (`meetings.channel_id`). Planned from a channel, it is that channel;
  planned for people, the server opens (or reuses) the direct or group
  conversation of the organizer and the invitees. Invitees must be able to read
  the place; the organizer chooses only people of the workspace.
- **Time**: start and end as instants plus the organizer's time zone (IANA). A
  repeating meeting has a rule in a subset of RFC 5545 RRULE: `FREQ=DAILY|WEEKLY|MONTHLY`,
  `INTERVAL` (1–12), `BYDAY` (weekly only), and `UNTIL` or `COUNT` (at most 2 years,
  at most 400 occurrences). Occurrences are worked out in the organizer's time
  zone, so 14:00 stays 14:00 across daylight saving changes. One occurrence can be
  cancelled (`EXDATE`); changing the meeting changes every occurrence.
- **Answers**: each invitee answers yes, maybe or no in Cenacle (the organizer is
  yes). E-mails carry no one-click answer links: mail scanners open links and
  would answer for the person.
- **Join**: the meeting's Join opens 5 minutes before an occurrence and stays
  until its end; it starts or joins the call of the meeting's place, as the
  call button there does.
- **Reminders**: a new notification section, Meetings: a reminder before each
  occurrence (off, 5, 10 or 15 minutes; 10 by default), shown in the app and by
  web push while away, within the person's pause and quiet hours; and whether
  invitations come by e-mail (on by default).
- **E-mail**: invitations, changes and cancellations go to invitees with a
  verified address, as HTML with a plain-text part and an iCalendar file
  (`METHOD:REQUEST`, or `CANCEL`; the same `UID` and a growing `SEQUENCE`, so the
  person's calendar adds, updates and removes one entry). The templates are
  `html/template` files in the binary, 600px wide tables, no remote images (the
  logo is an inline part), English or Turkish by the person's language, which
  the app now stores on the server (`users.language`, set when it changes). The
  e-mails are written to an outbox in the same transaction as the change and
  sent by a periodic job; a failed send is tried again on later runs (at most
  for a day). Administrators can send themselves a test e-mail.
- **Calendar**: the app shows a week and a month view of the meetings one is
  invited to. Each meeting downloads as `.ics`, and each person can create a
  private subscription address (a random token, stored hashed, revocable) that
  mail and calendar programs read; it shows the next 6 months and the past month.
- **Workspace events stay apart**: the open, workspace-wide events with
  going/maybe answers keep their own pages; the calendar shows them too, for the
  people who answered going or maybe.

## Consequences

- Answers given in a mail client's calendar ("Accept") do not reach Cenacle; the
  e-mail says to answer in Cenacle, and the attached file asks for no reply.
- The subscription address works without signing in, by design; it shows
  meeting titles, times and places only (not agendas), and a person can
  replace it at any time.
- A deleted channel takes its meetings with it; a person leaving a workspace
  leaves its meetings.
