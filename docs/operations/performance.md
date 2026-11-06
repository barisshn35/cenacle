# Performance

## Load test

`make load` runs the chat server in process (HTTP, PostgreSQL, Valkey, WebSockets) with
many people at once and reports what they would feel. Settings: `LOAD_USERS` (people
sending, default 100), `LOAD_SOCKETS` (live connections, 200), `LOAD_SECONDS` (20),
`LOAD_PROFILE` (a CPU profile file), `LOAD_REPORT` (the numbers as JSON). Use a test
database: the test creates and drops its own schema.

Every person sends messages one after another into one channel while 200 connections
receive them all; then everyone pages back through the history and searches.

Results on one 12-core machine with PostgreSQL, Valkey and the test itself on it
(milliseconds, median / 95th percentile). The 0.27.0 and 0.43.0 columns were measured
again side by side on the same day, three runs each (one shown), with the tables
analyzed before reading back (see below); the 0.26.0 column is from its release. The
0.99.4 column is the median of three runs on 2026-11-03, on the same host while about 30
other containers ran on it; the 1.0 column likewise, of the 1.0 code on 2026-11-05
(14:53–14:55 UTC):

| Measure                             | 0.26.0    | 0.27.0    | 0.43.0    | 0.99.4    | 1.0       |
| ----------------------------------- | --------- | --------- | --------- | --------- | --------- |
| Messages per second (100 senders)   | 241       | 371       | 346       | 311       | 366       |
| Send a message                      | 418 / 544 | 246 / 385 | 279 / 403 | 335 / 456 | 261 / 400 |
| Message reaches all 200 connections | 428 / 560 | 253 / 392 | 286 / 411 | 342 / 469 | 268 / 406 |
| Page of history                     | 402 / 472 | 87 / 131  | 90 / 132  | 107 / 148 | 94 / 125  |
| Search                              | 353 / 751 | 390 / 719 | 41 / 45   | 374 / 647 | 61 / 73   |

Search in 0.99.4 falls into two groups: in six runs its median was 50, 55 or 57 ms in three
and 374, 403 or 411 ms in the others, with nothing else changed. The cause (found on
2026-11-03 with the plans PostgreSQL logged): the test's searches (`load-5`) found no
message, because the search dropped the hyphen and looked for words starting with `load5`.
For such a search PostgreSQL chooses between the search index and reading messages newest
first. New entries of the search index wait in a list until the table is vacuumed, and the
test only analyzes it; while that list is long, reading every message looks cheaper, and
each search then takes about 50 ms in the database instead of under 1 ms.

Since migration 00059 a word with a hyphen is found, so the test's searches return results
(a page of 21). Measured again on 2026-11-03 (20 runs, same host): the search median was
130–159 ms in 18 runs and 51 and 91 ms in two; the 95th percentile 166–261 ms (60 and
105 ms in the two). In the database each logged search read messages newest first and
stopped at a page of results, in about 21–24 ms (median of the searches over 20 ms); the
rest of the time is waiting for one of the server's database connections while 100 people
page through history and search at once.

Migration 00060 (below) lets new messages go into the search index at once, which costs a
little on every message. `make load` on 2026-11-03, 20:45–20:56 UTC, same host, 10 runs
without 00060 and 10 with it, taken in turns (medians of the runs' medians and 95th
percentiles; the range of the runs' medians in brackets):

| Measure           | Without 00060          | With 00060             |
| ----------------- | ---------------------- | ---------------------- |
| Messages a second | 340.6 (290.1–352.0)    | 335.3 (248.9–360.1)    |
| Send a message    | 285 / 391 ms (248–317) | 268 / 447 ms (250–435) |
| Search            | 123 / 157 ms (56–152)  | 97 / 121 ms (93–170)   |

The runs differ more from each other than the two columns do. Measured alone on the
database of two million messages, one message took 1.72 ms to write instead of 1.55 ms
(medians of the writes before and after the migration, 50 a second, in two runs).

**Rare words on a large server.** Until migration 00060, a search for a rare word read every
message: PostgreSQL has no statistics for the words of the search index (a partial index,
whose statistics the planner does not use), guessed that 2% of messages match and read them
all newest first. With two million messages that took about 41 seconds, and the person got
no answer, because the server stops writing a response after 30 seconds. Migration 00060
adds statistics on the search expression and lets new messages go into the index at once.

Measured on 2026-11-03 over HTTP, one chat server and PostgreSQL 18.6 on the same host:
2,000,000 messages over a year in 100 channels (12 words each, drawn from 5,000 words, few of
them common), 200,000 files with 80 words of text each and names such as
`Fatura w2160 2027.pdf`, one person in every channel. Medians in milliseconds, of 10 searches
(30 for the last two of each kind; 3 to 5 before the migration). "New messages" is the same
database with 50,000 more messages not yet vacuumed:

| Search for a word …              | Before 00060       | With 00060 | With 00060, new messages |
| -------------------------------- | ------------------ | ---------- | ------------------------ |
| in 10 messages                   | 42,134 (no answer) | 7.8        | 7.9                      |
| in no message                    | 41,453 (no answer) | 5.8        | 7.5                      |
| in 1,189 messages                | 707                | 10.7       | 11.7                     |
| in almost every message          | 6.9                | 6.7        | 6.5                      |
| in the text of 10 files          | 23,111             | 11,239     | 11,839                   |
| in no file                       | 22,817             | 7,621      | 8,013                    |
| in the text of 728 files         | 443                | 989        | 1,032                    |
| in the text of almost every file | 14.9               | 15.1       | 16.0                     |

**Files.** With migration 00060 alone, searching files was still slow for rare words. Since
this change the name and the text are looked up apart, each part with its own index; but the
text part still read files newest first, working out the words of each file's text as it
went, because PostgreSQL took that for cheap: `cenacle_search_vector` is a short SQL function
that PostgreSQL copies into the query, and the copy has no cost of its own. A search stops
after 10 seconds (also since this change), so a word in 10 files or in none ended with "This
search took too long". Measured on 2026-11-03, 22:17–22:36 UTC, on the same kind of database
built again (names such as `Teklif w557 2026 1.pdf`), over HTTP, medians of 10 or 30
searches:

| Search for a word …              | Without 00060  | With 00060     | With 00060, new messages |
| -------------------------------- | -------------- | -------------- | ------------------------ |
| in the text of 10 files          | stopped (10 s) | stopped (10 s) | stopped (10 s)           |
| in no file                       | stopped (10 s) | stopped (10 s) | stopped (10 s)           |
| in the text of 721 files         | 791            | 791            | 785                      |
| in the text of almost every file | 18.5           | 19.9           | 20.4                     |

Migration 00061 gives the function its cost (`COST 10000`) and a `SET search_path`, which
keeps PostgreSQL from copying it; the function and its results are the same. Measured on
2026-11-04 (searches 13:20–13:26, names 13:35–14:05, pages 13:28–13:35, writing 13:16–13:20
UTC), on the same kind of database built again
(2,000,000 messages, 200,000 files with 80 words of text each, vacuumed and analyzed), over
HTTP, one chat server and PostgreSQL 18.6 on the same host, the function switched back and
forth between the runs (old, new, new, old). Medians in milliseconds of each run (5 searches
for the first four rows of each kind, 10 for names, 15 for the rest). The searches marked
"names" ran on a build that waits 120 seconds instead of 10, to see how long they take; on
the release they stop after 10 s:

| Search                                         | Without 00061     | With 00061 |
| ---------------------------------------------- | ----------------- | ---------- |
| messages: a word in 10 messages                | 13.5, 12.5        | 34.4, 33.0 |
| messages: a word in no message                 | 10.9, 12.0        | 31.4, 36.4 |
| messages: a middling word (`w2500`)            | 14.5, 19.4        | 28.9, 31.8 |
| messages: a word in almost every message       | 10.8, 10.1        | 8.8, 8.8   |
| messages: two words (`w12 w340`)               | 1,247, 1,314      | 127, 140   |
| messages: a word without another (`w1 -w2`)    | 21.8, 14.7        | 66.5, 67.0 |
| files: a word in the text of 10 files          | stopped (10 s) ×2 | 15.4, 15.8 |
| files: a word in no file                       | stopped (10 s) ×2 | 14.5, 15.5 |
| files: a middling word (`w2500`)               | 601, 673          | 29.7, 27.4 |
| files: a word in the text of almost every file | 20.6, 26.2        | 61.1, 58.5 |
| files: two words (`w12 w340`)                  | 57.0, 57.3        | 757, 775   |
| files: a word without another (`w1 -w2`)       | 283, 318          | 402, 390   |
| files, names: `rapor` (in no text)             | 20,763, 22,339    | 81.9, 63.5 |
| files, names: `w7 2021`                        | 23,075, 24,777    | 80.6, 60.8 |
| files, names: `toplantı`                       | 22,845, 24,181    | 67.0, 59.4 |

`w2500` is the word of the rows "1,189 messages" and "721 files" in the tables above, from
earlier builds of the same data (its words are drawn at random, so each build differs a
little). Every search measured here now answers within a second; some that were fast take
longer, most of all two words in file texts (57 ms → 0.77 s). Three pages of 7 results of 18
searches (the ones above, in messages and in files) were the same, result for result, with
the old and the new function (fetched on the 120-second build).

More searches on a new build of the same database (2026-11-04, 17:16–17:29 UTC, the
120-second build, 5 searches each, the function switched old, new, new, old): three and four
words (`w1 w2 w3`, `w12 w340 w56 w789`, `w5 w50 w500 w4000` and others), two words found
almost everywhere (`w1 w2`), a rare word with two common ones (`zumrut w1 w2`,
`yakut w1 w2`), in messages and in files, for a person in all 100 channels, a person in 3 of
them and a guest in 2; 50 searches. With 00061 every median of the measured searches stays
under 0.65 s: the slowest are two words in file texts (`w12 w340`, 0.50–0.63 s) and
`zumrut w1 w2` in messages (0.58–0.59 s). Without it 11 of the 50 take longer than a
second, up to 11.4 s (`yakut w1 w2` in files), so the release would stop them after 10 s.
Medians in milliseconds of the two rounds:

| Search                                        | Without 00061  | With 00061 |
| --------------------------------------------- | -------------- | ---------- |
| messages: `w1 w2` (every channel)             | 11.3, 10.6     | 35.1, 35.9 |
| messages: `w1 w2 w3 w4` (every channel)       | 10.1, 11.4     | 37.7, 40.5 |
| messages: `w5 w50 w500 w4000` (every channel) | 198, 152       | 146, 139   |
| messages: `zumrut w1 w2` (every channel)      | 642, 580       | 591, 576   |
| messages: `zumrut` (3 channels)               | 7.8, 7.0       | 28.1, 28.8 |
| messages: `zumrut` (guest, 2 channels)        | 7.2, 7.7       | 29.7, 27.2 |
| files: `w1 w2` (every channel)                | 2,084, 2,074   | 49.2, 47.7 |
| files: `w12 w340` (every channel)             | 68.2, 62.3     | 547, 526   |
| files: `w12 w340 w56` (every channel)         | 1,952, 2,006   | 64.0, 71.7 |
| files: `yakut w1 w2` (every channel)          | 11,402, 10,515 | 311, 251   |
| files: `yakut` (3 channels)                   | 10,646, 10,368 | 11.3, 13.2 |
| files: `rapor`, a name (guest, 2 channels)    | 7,127, 6,687   | 56.5, 62.9 |
| files: `w12 w340` (guest, 2 channels)         | 320, 327       | 505, 631   |

A word in a few messages, and a middling one, take 7–11 ms without 00061 and 26–30 ms with
it: PostgreSQL then reads the matching messages with two parallel workers, and starting
them takes longer than the search.

Writing costs the same. The same runs, switched back and forth (milliseconds, median of each
run): sending a message over HTTP (500 messages, 12 words) 14.0, 13.0, 12.3, 15.0 without
and 16.0, 14.3, 12.9, 12.0 with 00061; writing a file's read text (the statement of the text
extraction job, 500 files, 80 words) 0.63, 0.62, 0.66, 0.59 and 0.62, 0.54, 0.52, 0.64;
inserting a message inside PostgreSQL (2,000 messages) 0.64, 0.67, 0.68 and 0.58, 0.70, 0.61.
`make load` (100 people sending, 20 seconds, five runs each, alternately, 12:38–12:43 UTC): search median
97–146 ms without and 69–86 ms with 00061 (medians of the runs 128 and 74), sending median
306–337 ms and 315–357 ms (320 and 330).

`TestScale` (below) did not show any of this: its rare search is two words (`item 1999993`),
and PostgreSQL guesses fifty times fewer matches for two words than for one, so it used the
index. On the database above, before 00060, `zumrut` alone took 39.6 s in the database and
`w1 zumrut` 0.43 s. Its single word (`review`) is in every eighth message, so a page of
results comes early.

With 100 people sending without pause, sending time is mostly waiting in line: real
conversations are far below this rate. Sending is a little slower than in 0.27 because a
message is checked for more (mention groups, encryption, retention, priority); no request
failed.

Until 0.43 the test read back before PostgreSQL had analyzed the freshly filled table, and
the planner then guessed that the channel was nearly empty: a page of history took 80 or
500 ms depending on whether autovacuum had come by. A server's tables are analyzed as they
grow, so the test now does it first.

## Large data

`TestScale` (build tag `load`, run with `go test -tags load -run '^TestScale$'
./internal/app/` in `server/`) writes messages straight into the database, as years of use
would, and times what people open most. Settings: `SCALE_MESSAGES` (2,000,000),
`SCALE_CHANNELS` (200), `SCALE_PEOPLE` (50), `SCALE_ROUNDS` (20), `LOAD_REPORT`. The reader
is in every channel, is mentioned in one message in two hundred and has read all but the
last 200 messages of each channel.

With 2,000,000 messages (milliseconds, median / 95th percentile):

| Request                        | 0.42.0      | 0.43.0    | 0.99.4    | 1.0       |
| ------------------------------ | ----------- | --------- | --------- | --------- |
| Channel list (with counts)     | 5996 / 6418 | 27 / 41   | 31 / 40   | 36 / 63   |
| Unread messages (200 channels) | 120 / 152   | 113 / 178 | 126 / 173 | 125 / 172 |
| Activity                       | 137 / 159   | 58 / 101  | 66 / 126  | 91 / 135  |
| Threads                        | 3 / 11      | 2 / 11    | 3 / 11    | 2 / 10    |
| History, newest page           | 7 / 11      | 6 / 10    | 8 / 12    | 7 / 11    |
| History, far back              | 7 / 11      | 6 / 10    | 8 / 11    | 8 / 11    |
| Search, common word            | 8 / 10      | 7 / 11    | 8 / 12    | 45 / 61   |
| Search, rare term              | 59 / 72     | 55 / 75   | 64 / 71   | 75 / 102  |

The 0.99.4 column is the median of three runs on 2026-11-03. The 1.0 column is the median of
three runs of the 1.0 code on 2026-11-05 (14:55–15:14 UTC; 20 rounds each, the files of the
test below included): a rare word 24 / 32, a word in no message 24 / 32, in the text of
files 13 / 19 and 9 / 16. The common word is slower than in 0.99.4 because of migration
00061 (explained below), not because the code got slower elsewhere. "Search, rare term" is two
words (`item <n>`), which PostgreSQL looks up in the index even without statistics; a rare
single word is measured above (Rare words on a large server).

Since this change the test also writes a file for every tenth message (a name and 80 words
of text) and searches for one word in ten messages, ten files or none; their medians fail
the test above 1 second (`scaleSearchLimit`: they take 10–30 ms, the slow plan took 7–40 s
or ran into the 10-second search limit). On 2026-11-04 (20 rounds, milliseconds, median /
95th percentile), 14:14–14:21 UTC: a rare word 25.4 / 31.2, a word in no message
25.8 / 29.7, in the text of files 14.0 / 18.8 and 9.6 / 14.2. Without migration 00061
(14:06–14:14 UTC) the same test failed in its first round: the file search for the rare word
stopped after 10 seconds (HTTP 503). In that run the common word took 49 / 62 ms and the rare
term 80 / 90 ms, against 8 / 12 and 64 / 71 in the 0.99.4 column above.

The common word is slower because of 00061, not because of the file texts. The test four
ways, one after the other on 2026-11-04 (17:31–17:59 UTC, 10 rounds, a build that waits 120
seconds for a search, milliseconds, median / 95th percentile):

| Search              | 80 words, 00061 | 80 words, no 00061 | 39 words, 00061 | 39 words, no 00061 |
| ------------------- | --------------- | ------------------ | --------------- | ------------------ |
| Common word         | 42.9 / 50.3     | 10.1 / 13.2        | 41.4 / 55.0     | 9.3 / 12.3         |
| Rare term           | 70.2 / 78.7     | 69.9 / 78.6        | 69.3 / 78.1     | 63.2 / 78.6        |
| Rare word           | 23.5 / 28.4     | 7.1 / 7.5          | 23.6 / 26.4     | 5.8 / 7.2          |
| Word in nothing     | 24.0 / 26.7     | 6.4 / 8.8          | 23.7 / 27.5     | 5.5 / 5.8          |
| Files, rare word    | 11.7 / 14.1     | 11,195 / 12,002    | 10.9 / 12.4     | 10.6 / 13.7        |
| Files, no such word | 9.5 / 13.5      | 7,429 / 7,994      | 7.9 / 17.5      | 8.5 / 14.1         |

Without 00061 and with 80 words the test fails (both file searches over a second); with 39
words of text it passes even without 00061, which is why it now writes 80. With 00061
PostgreSQL runs the common word on two parallel workers: on a copy of the test's data (same
statements, 2,000,000 messages, 200,000 files) the search took 2.9 ms without 00061, 48.8
ms with it and 3.0 ms with it and parallel query turned off for the session
(`max_parallel_workers_per_gather = 0`); with 39-word texts 3.1, 49.6 and 2.9 ms (7 runs
each, medians). Starting the workers takes about 40 ms; the search itself does not get
slower.

Unread messages return 20 messages for each of the 200 channels at once: most of their
time is that payload.

Background jobs on a large database (0.99.1, three million messages): the retention job
read every message, checking legal holds on each, before looking at retention, and ran into
its 60-second limit every two minutes, also where no retention was set. It now reads only
channels with a retention, through their index: 0.5 ms without one, 0.6 s for each thousand
messages it deletes with one. Every other job finished within 2 seconds. Upgrading that
database from 0.30 took 34 seconds of migrations ([upgrade](../upgrade/README.md)).

## Soak

`TestSoak` runs the server at an ordinary pace for a long time (`LOAD_SECONDS`, default
600): `SOAK_RATE` messages per second (20) from 50 people, `LOAD_SOCKETS` live connections
(200), of which `SOAK_CHURN` percent (20) close and reconnect every minute. It samples the
heap, goroutines and database connections and fails when, after the first quarter, any of
them keeps growing.

0.43.0 for 20 minutes: 24,000 messages, 4.8 million events delivered, no failed request;
goroutines 824 from the first minute to the last, database connections 7, heap from
17.0 to 19.8 MB (the server's caches filling with the new messages).

0.99.1 for 24 hours: 1.7 million messages, 346 million events delivered, 57,600
connections replaced; goroutines 824 to 825 and database connections 6 to 9 throughout.
The test itself held on to closed connections and outlived its sessions; with that fixed,
an hour of 1,000 connections replaced every minute kept the heap between 43.7 and 46.1 MB
([QA report](../qa/report-0.99.1.md)). `SOAK_HEAP_PROFILE` writes a heap profile at the
end of a run.

## What changed in 0.43.0

- **Channel list:** the unread and mention counts read from the last read message on
  (mentions now carry their channel, migration 00046) instead of every message of every
  channel.
- **Activity:** each kind of activity is read for the last 30 days only.
- **No JIT:** PostgreSQL's JIT compilation is off for the server's connections. It took
  about 35 ms of a 57 ms channel list; the server's queries are short. Add `jit=on` to
  `CENACLE_DATABASE_URL` to keep it.

## What changed in 0.27.0

- **Database connections:** a server keeps up to `CENACLE_DATABASE_MAX_CONNS` (default 25,
  was one per CPU). Busy servers waited for a free connection. Keep the sum over all
  instances (and Cenacle ID) below PostgreSQL's `max_connections` (100 by default).
- **Live events:** each event is read and encoded once for all connections of an
  instance, instead of once per connection.
- **Web app:** the first download no longer carries code that loads later (code
  highlighting, emoji data, admin pages): about 1.6 MB of JavaScript instead of 4.4 MB,
  before compression.

## Profiling a running server

Set `CENACLE_METRICS_ADDR` to expose Prometheus metrics (see Monitoring in the
[operations guide](README.md)); for CPU profiles, run the load test with `LOAD_PROFILE`
and open it with `go tool pprof`.

## Calls: measured capacity

Measured on 2026-11-06 with `server/cmd/media-load` against the media image built
with `-tags medialab` (rooms up to 25, otherwise the release code), in a container
limited to **4 CPUs and 8 GB** (`docker run --cpus 4 --memory 8g`), the reference
media host. The load generator ran on the same machine outside the container, so
its own CPU did not count against the media server.

Each person sends Opus audio (about 32 kbit/s) and a camera as three VP8 simulcast
layers within the web app's sender budget (320x180 at 15 fps, 640x360 and
1280x720 at 30 fps; 10/25/65 % of 75 % of the 2.5 Mbit/s ceiling), uses the web
app's signalling, receives everyone else, and asks for its layers with tile hints:
"grid" is every camera in a 400 px tile, "speaker" one 960 px tile and the rest
160 px. Half way through, everyone reconnects once (the app's path after a lost
connection). "2 % loss" drops 2 % of packets in both directions on the media
container's interface (`tc netem`). Each run lasts 120 s.

Before the runs these were the pass criteria: media CPU p95 at most 70 % of the 4
CPUs (280 % of one core), delivered loss under 1 % on a clean network and no more
than the injected loss otherwise, audio delay p95 under 50 ms, every stream back
after the reconnect, and no failures.

| Profile (4 CPU / 8 GB)            | CPU p95 (one core = 100 %) | RSS     | Egress     | Loss   | Audio delay p95 / p99 | Rejoin p95 | Streams after rejoin | Result |
| --------------------------------- | -------------------------- | ------- | ---------- | ------ | --------------------- | ---------- | -------------------- | ------ |
| 8 people, 1 room, grid            | 44 %                       | 106 MiB | 16 Mbit/s  | 0 %    | 0.7 / 1.0 ms          | 28 ms      | 112 / 112            | pass   |
| 8 people, 1 room, speaker         | 51 %                       | 107 MiB | 16 Mbit/s  | 0 %    | 0.8 / 1.4 ms          | 33 ms      | 112 / 112            | pass   |
| 8 people, 2 rooms                 | 85 %                       | 179 MiB | 33 Mbit/s  | 0 %    | 0.9 / 1.5 ms          | 37 ms      | 224 / 224            | pass   |
| 8 people, 2 rooms, 2 % loss       | 96 %                       | 176 MiB | 33 Mbit/s  | 0.99 % | 1.3 / 75 ms           | 1.0 s      | 224 / 224            | pass   |
| 16 people, 1 room, grid           | 143 %                      | 313 MiB | 70 Mbit/s  | 0.02 % | 2.4 / 9 ms            | 113 ms     | 480 / 480            | pass   |
| 16 people, 1 room, speaker        | 137 %                      | 313 MiB | 70 Mbit/s  | 0.04 % | 2.0 / 13 ms           | 186 ms     | 480 / 480            | pass   |
| 16 people, 1 room, 2 % loss       | 140 %                      | 310 MiB | 70 Mbit/s  | 1.05 % | 2.6 / 74 ms           | 1.2 s      | 480 / 480            | pass   |
| 16 people, 2 rooms                | 237 %                      | 583 MiB | 139 Mbit/s | 1.05 % | 11 / 49 ms            | 1.2 s      | 958 / 960            | fail   |
| 25 people, 1 room (informational) | 301 %                      | 699 MiB | 165 Mbit/s | 3.55 % | 1595 / 1874 ms        | 1.9 s      | 1170 / 1200          | fail   |

A 30-minute soak with the release image (16 people, everyone reconnecting six
times) kept every stream (480 of 480 after the last reconnect), with 0.003 % loss,
audio delay p95 2 ms and CPU p95 136 % of one core. Memory went from 294 MiB in the
first minute to 318 MiB in the last (median 313 MiB): it levels off instead of
growing.

So a workspace may allow up to **16 people per call** (the default stays 8). One
4 CPU / 8 GB media host carries one 16-person call, or two 8-person calls, with
room to spare; two 16-person calls at once overload it slightly (delay and loss
rise, a few streams are late after reconnecting), and 25 people in one call do
not fit. Give the media host more CPUs for more simultaneous large calls: the
SFU's cost grows with the number of streams it forwards (people times receivers).
With 2 % loss both ways, retransmissions (NACK) bring delivered loss to about
1 %; the p99 audio delay of about 75 ms is a retransmitted packet.

The measurements found and fixed four faults: the SFU and the browser offered each
other without end when someone joined listen-only; padding packets (bandwidth
probes) made the SFU drop the publisher; a publisher reconnecting could leave a
receiver subscribed to its old publication; a single unanswered authorization
request, or a description over 32 media sections (16 people), ended the
transport. Regression tests cover each (`server/internal/media/negotiation_test.go`).

Run it again on your own media host (keys and the Valkey address are those of
that media server; `-pid` samples its CPU and memory from the host):

```sh
docker build -f server/media.Dockerfile --build-arg TAGS=medialab -t cenacle-media:lab .
go -C server build -tags medialab -o media-load ./cmd/media-load
./media-load -signal ws://MEDIA:7880/media/ws -control HOST:7883 -valkey VALKEY:6379 \
  -calls-key calls-private.pem -control-key control-public.pem \
  -rooms 1 -people 16 -seconds 120 -pid "$(docker inspect -f '{{.State.Pid}}' MEDIA_CONTAINER)"
```

The media server's `CENACLE_MEDIA_CONTROL_URL` must point at the tool
(`http://HOST:7883/control`), and its `CENACLE_PUBLIC_URL` must be the tool's
`-origin` (default `https://chat.load.test`). A `medialab` build also serves
`GET /lab/state` (every transport and subscription); release images have neither
the larger rooms nor that page. `-lab URL` makes the tool explain streams that
never arrived.

The in-process `TestSFUAudioLoad` (`CALLS_LOAD=1`) remains a quick audio-only
check of forwarding; it does not measure capacity.

Browser checks with real Chromium (`make test-e2e-stack` with `STACK_CALLS=1` and
`STACK_CALLS_PUBLIC_IP` set to a non-loopback address of the test host): two
people with camera and microphone, a reconnect as the same participant, a direct
call declined and then accepted, and three people with one shared screen at a
time.
