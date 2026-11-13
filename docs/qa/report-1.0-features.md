# QA report: the features added before 1.0

Before 1.0 a set of features was added on `main`: named group conversations, forwarding
several messages, out of office with an automatic reply, the Today view, charts and live
cards, raised hands and reactions in calls, the check before joining, noise suppression and
background blur, live captions and call notes, recording with consent, meetings with
invitation e-mails and four calendar views, search by meaning, assistants over MCP and the
web push encryption note. This round checked them on a real stack, the way the
[test plan](test-plan.md) does for a release. 2026-11-13.

## Result

No blocker is open. In two rounds, three major and eleven minor findings were fixed. What was
not tested is listed at the end.

## Findings

| #   | Where      | What happened                                                                                                                                                                                                                                    | Severity | Fixed in    |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- |
| 1   | Calls      | Leaving a call with the microphone or camera on looped in the code that stops the tracks; the leave never reached the server, so the call stayed open for the others and never ended.                                                            | major    | b5587f5     |
| 2   | Tests      | The whole-stack call tests did not know the check before joining and stopped at it.                                                                                                                                                              | minor    | 8af4643     |
| 3   | Settings   | `STACK_CALLS_PUBLIC_IP`, which the whole-stack call tests need, was not in `.env.example`.                                                                                                                                                       | minor    | 8af4643     |
| 4   | Calls      | In the check before joining, "Your microphone works" showed only while the current sound was loud: speech flipped it with "Say something to test it" at every syllable, and a screen reader announced each flip.                                 | minor    | 8c0be00     |
| 5   | Tests      | The role journeys did not read the two new administration pages (search by meaning, assistants).                                                                                                                                                 | minor    | 29b2953     |
| 6   | Tests      | Nothing tried the new features on the real stack: the server's automatic reply, meeting e-mails, MCP, a call's hands, reactions, recording and captions between two browsers, search by meaning.                                                 | minor    | 29b2953     |
| 7   | Background | When the server is stopped while the search-by-meaning job runs, the job stays "running" until River gives it up (about an hour); no new indexing starts meanwhile. Noted in the operations guide.                                               | minor    | this report |
| 8   | Guides     | The calls security review and the accessibility report still said calls have no live captions (WCAG 1.2.4 "Does not support").                                                                                                                   | minor    | this report |
| 9   | Interface  | The Turkish button under a new assistant token said "Tamam", which the wording rules leave out (a button says what it does); the unit test of the texts failed on `main`.                                                                        | minor    | 508b61b     |
| 10  | Calls      | Captions follow the speaker's interface language: someone with the English interface who spoke Turkish got an English translation, and a wrong one ("4 aralık" became "the 4th of May"). Each person now says which language they speak.         | major    | 1d4bb89     |
| 11  | Meetings   | A meeting with one person (in their direct conversation) named the place by the channel's internal name in its e-mails and calendar files ("Cenacle call in direct:01a1…:01a1…"): the code looked for the kind `dm`, the database says `direct`. | major    | b67f964     |
| 12  | Calls      | Screen readers were not told when someone else raised a hand; the hand showed only on the tile. Reactions were already told.                                                                                                                     | minor    | 1d4bb89     |
| 13  | Layout     | Calendar, Today and the other views across channels, opened in a window about 770 to 890 px wide (an iPad held upright), kept an empty details panel and had half the width.                                                                     | minor    | 489d9a8     |
| 14  | Meetings   | The meeting e-mails stayed 600 px wide on phones (a table's `max-width` is ignored): readers scrolled sideways at 320 px in all three engines. They now fit, with a fixed width only for Outlook on Windows.                                     | minor    | 0412858     |

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

## Round 2: what round 1 left open

- **Accessibility (S24)**: the conformance report is assessed again for 1.0 (findings 10, 12
  and 13 came from it); see [the report](../accessibility/conformance-report.md).
- **Captions in Turkish**: a Turkish sentence spoken by a synthesized voice (Piper,
  `tr_TR-dfki-medium`) through the whole stack with the `ggml-small` model the trial server
  runs: "Yeni sürümü 4 aralıkta yayınlıyoruz. Toplantı Perşembe sabah saat 10'da
  başlayacak. Lütfen raporları Çarşamba'ya kadar gönderin." came out word for word. Asked
  for English, the same speech came out translated (finding 10); letting the model detect
  the language works for sentences but mistook a lone "Evet." for French, so the choice is
  the person's.
- **A hosted model**: no hosted service was called (that needs an account's key). What a
  hosted service does differently is now tested against a stand-in over HTTPS that asks
  for a key, refuses a request with 429, answers out of order and gives 1536- and
  3072-wide vectors: the client's tests (`internal/ai`) and a search by meaning on
  PostgreSQL with a 3072-wide index whose refused batch is indexed on the next run. The AI
  guide says what Cenacle sends a hosted model.
- **The calendar on phones**: the calendar, Today, meetings and the shell's tests in WebKit,
  Safari's engine, with iPhone SE, iPhone 15 and iPad profiles (touch, their screen sizes
  and user agents). Phones show the agenda with no sideways scrolling, and a tap opens a
  meeting. The iPad profile found finding 13. Two tests needed changes for WebKit (it
  knows no clipboard permissions; the remote browser's time zone).
- **Meeting e-mails**: the invitation, change and cancellation in English and Turkish,
  opened in WebKit (Apple Mail's engine), Gecko (Thunderbird's) and Chromium, at 320 and
  600 px, light and dark (finding 14). Their calendar files pass a strict iCalendar parser:
  CRLF lines of at most 75 octets, a VTIMEZONE for each TZID, ORGANIZER and ATTENDEE as
  `mailto:`, SEQUENCE, STATUS CANCELLED on a cancellation. The whole-stack test now checks
  where the e-mail says the meeting is (finding 11).

## Not tested here

- A hosted model itself (OpenAI, Azure, Mistral and the like); see round 2 for what was.
- Captions in a human voice in Turkish, with accents, noise or several people talking.
- Real phones: the calendar was tried in Safari's engine, not on an iPhone or Android
  phone; calls were not tried on phones at all (the test browsers have no camera there).
- The meeting e-mails in Outlook, Gmail and Apple Mail themselves; their engines were used.
