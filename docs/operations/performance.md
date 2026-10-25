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
analyzed before reading back (see below); the 0.26.0 column is from its release:

| Measure                             | 0.26.0    | 0.27.0    | 0.43.0    |
| ----------------------------------- | --------- | --------- | --------- |
| Messages per second (100 senders)   | 241       | 371       | 346       |
| Send a message                      | 418 / 544 | 246 / 385 | 279 / 403 |
| Message reaches all 200 connections | 428 / 560 | 253 / 392 | 286 / 411 |
| Page of history                     | 402 / 472 | 87 / 131  | 90 / 132  |
| Search                              | 353 / 751 | 390 / 719 | 41 / 45   |

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

| Request                        | 0.42.0      | 0.43.0    |
| ------------------------------ | ----------- | --------- |
| Channel list (with counts)     | 5996 / 6418 | 27 / 41   |
| Unread messages (200 channels) | 120 / 152   | 113 / 178 |
| Activity                       | 137 / 159   | 58 / 101  |
| Threads                        | 3 / 11      | 2 / 11    |
| History, newest page           | 7 / 11      | 6 / 10    |
| History, far back              | 7 / 11      | 6 / 10    |
| Search, common word            | 8 / 10      | 7 / 11    |
| Search, rare term              | 59 / 72     | 55 / 75   |

Unread messages return 20 messages for each of the 200 channels at once: most of their
time is that payload.

## Soak

`TestSoak` runs the server at an ordinary pace for a long time (`LOAD_SECONDS`, default
600): `SOAK_RATE` messages per second (20) from 50 people, `LOAD_SOCKETS` live connections
(200), of which `SOAK_CHURN` percent (20) close and reconnect every minute. It samples the
heap, goroutines and database connections and fails when, after the first quarter, any of
them keeps growing.

0.43.0 for 20 minutes: 24,000 messages, 4.8 million events delivered, no failed request;
goroutines 824 from the first minute to the last, database connections 7, heap from
17.0 to 19.8 MB (the server's caches filling with the new messages).

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
