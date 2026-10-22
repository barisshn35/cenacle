# 0026. Workflows, forms and approvals (v0.21)

- Status: accepted
- Date: 2026-10-22

## Context

Teams repeat the same small processes in chat: greeting newcomers, collecting requests in
the same shape, asking someone to approve, reminding people on a schedule, telling another
system that something happened. Enterprise chat products offer a workflow builder for
this. Cenacle offers one without code, inside the workspace, open source.

## Decisions

1. **Forms belong to a workspace** (owners and admins write them; up to 200, 30 fields
   each). Field kinds: short and long text, number, date, one choice, several choices,
   checkbox, person. People fill a form from the composer: the answers become a message
   card in the channel. A submission keeps its answers as label/value pairs, so it still
   reads after the form changes.
2. **A workflow is a trigger and up to 25 steps**, stored as JSON and validated by the
   server. Triggers: started from the composer (in any channel or one), someone joins a
   channel, a reaction, a keyword in a message, a schedule (every day, weekday or week, at a
   time in a time zone), or a secret webhook address. Steps: post in a channel, send a
   direct message, have the starter fill in a form, ask for an approval, wait, send the
   variables to a web address.
3. **Variables** (`{{trigger.user}}`, `{{form.<field>}}`, `{{approval.status}}`,
   `{{webhook.<field>}}`, …) are filled in as plain text; unknown ones are empty.
4. **Runs copy the steps** when they start, so editing a workflow never changes a run in
   progress. A run is `running` (a step is due, now or after a wait), `waiting` (for a form
   or a decision), `done`, `failed` (with a reason) or `cancelled`.
5. **The engine is a periodic River job** (every 2 s) that claims due runs with
   `FOR UPDATE SKIP LOCKED`, one run per transaction, so several servers share the work and
   a failing run does not hold back others. Scheduled workflows are claimed the same way and
   their next time computed in their time zone.
6. **Tasks** are what a waiting run needs from people: a form for the starter, or a
   decision by one of the approvers (the first decides). Each task is a card in the
   person's conversation with the workspace's "Cenacle" bot; deciding or filling it in
   refreshes every copy of the card through `message.updated` and moves the run on. A
   rejection ends the run.
7. **Safety:**
   - Workflows never start on bots' messages or reactions (their own included), so they
     cannot trigger each other in a loop; a workflow starts at most 120 runs an hour.
   - Burn-on-read messages start nothing.
   - Outgoing requests go through the guarded egress client and are signed like event
     deliveries, with the workflow's own secret.
   - Webhook addresses are stored hashed and shown once.
   - Workflows and forms are audited.

## Consequences

- Steps run as the workspace's system bot, so its messages are recognizable and never
  impersonate a person.
- Branching is limited to an approval's rejection ending the run; conditions and loops can
  come later without changing stored runs (steps are a list).
