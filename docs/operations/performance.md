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
(milliseconds, median / 95th percentile):

| Measure                             | 0.26.0    | 0.27.0    |
| ----------------------------------- | --------- | --------- |
| Messages per second (100 senders)   | 241       | 373       |
| Send a message                      | 418 / 544 | 265 / 333 |
| Message reaches all 200 connections | 428 / 560 | 289 / 365 |
| Page of history                     | 402 / 472 | 114 / 483 |
| Search                              | 353 / 751 | 47 / 55   |

With 100 people sending without pause, sending time is mostly waiting in line: real
conversations are far below this rate. No request failed.

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
