# Operating Cenacle

Day-two tasks for a running installation: scaling, upgrades without downtime,
monitoring, support bundles, offline installs and moving from another chat.

## Several instances of the chat server

The chat server keeps no state of its own: sessions and messages are in PostgreSQL;
live events, presence and rate limits in Valkey; files in the object store. Background
work (event delivery, scheduled messages, clean-ups) runs once per installation, whichever
instance takes it (River jobs, PostgreSQL advisory locks). Run as many instances as needed:

```sh
docker compose -f prod.yml --env-file .env.prod up -d --scale server=3
```

Caddy finds every instance by its Compose service name and balances requests and
WebSockets across them (least connections). A WebSocket that ends when its instance
stops reconnects to another and resumes from the last event it saw.

## Upgrades without downtime

Migrations only add (expand) in a release and remove (contract) in a later one, so the
previous release keeps working against the new schema while instances are replaced.

- **Kubernetes (Helm):** `helm upgrade` runs the migrations as a pre-upgrade job, then
  replaces pods one at a time (`maxUnavailable: 0`). A stopping pod fails `/readyz` for
  `server.drainDelay` (10 s) so the Service stops sending to it, then finishes its
  requests.
- **Compose:** `docker compose up -d` replaces the containers of a service together, a
  restart of a few seconds; clients reconnect on their own and resume, and messages being
  sent are retried. For upgrades without any interruption, run on Kubernetes.

## Monitoring

| Signal  | Where                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Health  | `/healthz` (alive) and `/readyz` (database, Valkey, object store) on every service                                                    |
| Metrics | Prometheus format on an internal port: chat server `CENACLE_METRICS_ADDR` (e.g. `:9090`), Cenacle ID `IDP_METRICS_PORT` (e.g. `9091`) |
| Traces  | OpenTelemetry (OTLP/HTTP) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; sampling with `OTEL_TRACES_SAMPLER`                              |
| Logs    | JSON on stdout with `request_id` and, when tracing, `trace_id`                                                                        |

Nothing is sent anywhere unless you configure it; there is no telemetry to the project.

The optional observability stack runs Prometheus, Tempo, Loki (with Alloy collecting the
containers' logs) and Grafana with a Cenacle dashboard, on an internal network:

```sh
docker compose -f prod.yml -f observability.yml --env-file .env.prod up -d
ssh -L 3000:127.0.0.1:3000 your-server   # then open http://localhost:3000 (user admin,
                                         # password in secrets/grafana_admin_password)
```

Settings in `.env.prod`: `CENACLE_TRACE_SAMPLE_RATIO` (share of requests traced, default
`0.1`), `PROMETHEUS_RETENTION` (default `30d`) and `GRAFANA_PORT` (on `127.0.0.1`, default
`3000`).

Every component's usage reporting and update checks are off. Alloy reads the Docker API
through the read-only socket to collect logs of this Compose project only.

Main metrics: `cenacle_http_request_duration_seconds` (by route), `cenacle_websocket_connections`,
`cenacle_messages_sent_total`, `cenacle_file_uploads_total`, `cenacle_event_deliveries_total`,
`cenacle_db_pool_*`, `cenacle_idp_oidc_events_total`, and the Go and Node.js runtime metrics.

## Status and support bundles

```sh
docker compose -f prod.yml --env-file .env.prod exec server cenacle-server status
docker compose -f prod.yml --env-file .env.prod exec -T server cenacle-server support-bundle - > support.tar.gz
```

`status` checks the dependencies and counts people, workspaces, channels, messages,
files, sessions and pending work. A support bundle contains that report, the settings
with every secret replaced by `set`, and runtime facts; no messages, names or addresses.
Read it before sharing it.

## Offline (air-gapped) installs

On a machine with internet access:

```sh
deploy/airgap/bundle.sh [--observability] [--clamav] cenacle-airgap
```

It pulls and builds every image of the stack and writes `images.tar.gz`, the list of
images, checksums and `load.sh`. Copy the directory and the repository (or at least
`deploy/compose`) to the offline host, run `./load.sh`, then install as usual. ClamAV still
needs virus signatures: point it at a local mirror.

## Performance

How many connections a server keeps, the load test and its results: see the
[performance guide](performance.md).

## AI (optional)

AI features are off until a model you run is configured; see the [AI guide](ai.md).

## Federation

A workspace can share channels with a workspace of another Cenacle server (Federation, at
the top of the sidebar, for owners and admins): one side creates an invitation code, the
other connects with it, then channels are offered and accepted. Both servers must reach
each other at their public address; the connection shows when the other side was last
heard from and the last delivery error. Pausing a connection keeps events queued until it
resumes.

## Moving from Mattermost or Slack

Cenacle imports the history of another chat once, from its export files (it never
connects to the other product):

```sh
# Mattermost: mmctl export create; mmctl export download …; unzip, then:
docker compose … run --rm -v "$PWD/export.jsonl:/import.jsonl:ro" server \
  import mattermost /import.jsonl [workspace-for-direct-messages]
# Slack: workspace settings → Import/Export Data → Export; then:
docker compose … run --rm -v "$PWD/slack-export.zip:/import.zip:ro" server \
  import slack /import.zip "Workspace name"
```

| From Mattermost           | In Cenacle                                                     |
| ------------------------- | -------------------------------------------------------------- |
| Team                      | Workspace (by display name; created if missing)                |
| User                      | Person, matched by e-mail address to existing accounts         |
| Public / private channel  | Public / private channel; channel admins become its managers   |
| Direct and group messages | Conversations in the given workspace (default: the first team) |
| Posts and replies         | Messages with their original times (replies follow their post) |
| `@username`               | Mentions                                                       |

From Slack: users, public channels (`channels.json`), private channels (`groups.json`),
direct and group messages, and messages with mentions, links and formatting converted to
Markdown; join and leave notices are skipped.

People who do not have a Cenacle account yet get one without a way to sign in. When they
first sign in with Cenacle ID under the same **verified** e-mail address, that account
becomes theirs, with their history. Imported history counts as read. Running an import again
adds only what is missing. Files, reactions and custom emoji are not imported yet.
