# QA report: the features added before 1.0

Before 1.0 a set of features was added on `main`: named group conversations, forwarding
several messages, out of office with an automatic reply, the Today view, charts and live
cards, raised hands and reactions in calls, the check before joining, noise suppression and
background blur, live captions and call notes, recording with consent, meetings with
invitation e-mails and four calendar views, search by meaning, assistants over MCP and the
web push encryption note. This round checked them on a real stack, the way the
[test plan](test-plan.md) does for a release. 2026-11-13.

## Result

No blocker is open. One major and eight minor findings were fixed. What was not tested is
listed at the end.

## Findings

| #   | Where      | What happened                                                                                                                                                                                                    | Severity | Fixed in    |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| 1   | Calls      | Leaving a call with the microphone or camera on looped in the code that stops the tracks; the leave never reached the server, so the call stayed open for the others and never ended.                            | major    | b5587f5     |
| 2   | Tests      | The whole-stack call tests did not know the check before joining and stopped at it.                                                                                                                              | minor    | 8af4643     |
| 3   | Settings   | `STACK_CALLS_PUBLIC_IP`, which the whole-stack call tests need, was not in `.env.example`.                                                                                                                       | minor    | 8af4643     |
| 4   | Calls      | In the check before joining, "Your microphone works" showed only while the current sound was loud: speech flipped it with "Say something to test it" at every syllable, and a screen reader announced each flip. | minor    | 8c0be00     |
| 5   | Tests      | The role journeys did not read the two new administration pages (search by meaning, assistants).                                                                                                                 | minor    | 29b2953     |
| 6   | Tests      | Nothing tried the new features on the real stack: the server's automatic reply, meeting e-mails, MCP, a call's hands, reactions, recording and captions between two browsers, search by meaning.                 | minor    | 29b2953     |
| 7   | Background | When the server is stopped while the search-by-meaning job runs, the job stays "running" until River gives it up (about an hour); no new indexing starts meanwhile. Noted in the operations guide.               | minor    | this report |
| 8   | Guides     | The calls security review and the accessibility report still said calls have no live captions (WCAG 1.2.4 "Does not support").                                                                                   | minor    | this report |
| 9   | Interface  | The Turkish button under a new assistant token said "Tamam", which the wording rules leave out (a button says what it does); the unit test of the texts failed on `main`.                                        | minor    | 508b61b     |

## What was done

- **The automated suites** on the commit of this round: `make lint test licenses build`, the
  web app's end-to-end tests in both pointer sizes, Cenacle ID's end-to-end tests and the
  whole-stack suite.
- **A new whole-stack file** (`web/e2e-stack/features.spec.ts`) with real processes for
  Cenacle ID, the chat server, the web app and the media server, and the development
  Mailpit for e-mail:
  - out of office: one automatic reply in Deniz's name to Mert's first message, none to the
    second, and a group of three that gets a name everyone sees;
  - a meeting: the invitation e-mail with its `.ics` (METHOD REQUEST) in Mailpit, an answer
    from the invitee, and the cancellation e-mail (METHOD CANCEL);
  - an assistant over MCP with a token made in Settings: it reads General and leaves a
    draft above the message box, which the person puts in the box; without the token the
    endpoint refuses;
  - a call between two browsers: a raised hand and a reaction seen by the other, a
    recording the other is told about, posted to the channel when it stops, and live captions from a
    recording of speech through a local whisper.cpp server;
  - search by meaning with a local embedding model (bge-m3, 1024 dimensions, through Ollama):
    "release date" finds "We ship the new version on the fourth of December."
- **The trial server** upgraded with a backup first: migrations to 00080, the PostgreSQL
  image with pgvector, captions on with the `ggml-small` model under the production
  container limits (read only, no shell, user 65532); `/readyz` 200 and `/api/mcp` without
  a token refused.
- **Web push**: a test decrypts what the server sends as RFC 8291 says; the security guide
  says so.

## Not tested here

- Search by meaning and call notes with a hosted model; only local ones were used.
- Captions in Turkish speech; the sample was English.
- The four calendar views on a real phone (the browser's phone sizes were used).
- The meeting e-mails in desktop mail programs other than Mailpit's preview.
