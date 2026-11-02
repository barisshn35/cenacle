# Operating Cenacle

Day-two tasks for a running installation: scaling, upgrades without downtime,
monitoring, support bundles, offline installs and moving from another chat. Which versions
receive fixes and for how long: [releases and support](support-policy.md).

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
Traces and the access log record request paths with the tokens of webhook, workflow-hook,
invite and guest-link addresses replaced by `[redacted]`.

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

## Compliance

Audit log export and SIEM streaming, data subject requests, archive exports and data
spillage: [compliance.md](compliance.md).

## Federation

A workspace can share channels with a workspace of another Cenacle server (Federation, at
the top of the sidebar, for owners and admins): one side creates an invitation code, the
other connects with it, then channels are offered and accepted. Both servers must reach
each other at their public address; the connection shows when the other side was last
heard from and the last delivery error. Pausing a connection keeps events queued until it
resumes.

## Moving from another chat

Cenacle imports the history of another chat once, from its export files (it never
connects to the other product). An export is a file or a directory; mount it into a
one-off `server` container:

```sh
docker compose … run --rm -v "$PWD/export:/import:ro" server import <source> /import …
```

| Source      | Export to bring                                                                                         | Command                                          |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Mattermost  | `mmctl export create`, `mmctl export download`, unzipped `.jsonl`                                       | `import mattermost <file> [dm-workspace]`        |
| Slack       | Workspace settings → Import/Export Data → Export (`.zip`)                                               | `import slack <zip> <workspace>`                 |
| Rocket.Chat | `mongoexport` of `users`, `rocketchat_room`, `rocketchat_subscription` and `rocketchat_message` (JSON)  | `import rocketchat <dir-or-archive> <workspace>` |
| Zulip       | Organization settings → Export organization (or `manage.py export`), the `.tar.gz`                      | `import zulip <tar.gz> [workspace]`              |
| Discord     | [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter), format JSON, one file per channel | `import discord <dir-or-archive> [workspace]`    |
| Teams       | Messages saved from Microsoft Graph, laid out as below                                                  | `import teams <dir-or-archive> [workspace]`      |

A Rocket.Chat export, for example:

```sh
for c in users rocketchat_room rocketchat_subscription rocketchat_message; do
  mongoexport --uri "$MONGO_URL" --collection "$c" --out "export/$c.json"
done
```

A Teams export is the JSON Microsoft Graph returns (an array, or a page with `value`):
`users.json` (`GET /users`, optional: names and addresses), `teams/<team>/<channel>.json`
(`GET /teams/{id}/channels/{id}/messages?$expand=replies`) and `chats/<chat>.json`
(`GET /chats/{id}/messages`). Message HTML becomes Markdown.

What comes over: workspaces (a Mattermost team, a Zulip organization, a Discord server, a
Teams team; Slack and Rocket.Chat go into the workspace you name), people, public and
private channels with their managers, direct and group conversations, and messages with
their original times, mentions, links and formatting. Join and leave notices and other
system messages are skipped. Zulip topics are kept: the first message of a topic starts
with the topic in bold. Discord attachments stay links to Discord.

People who do not have a Cenacle account yet get one without a way to sign in. When they
first sign in with Cenacle ID under the same **verified** e-mail address, that account
becomes theirs, with their history. Discord does not export addresses: those people keep
their names and messages but cannot sign in. Imported history counts as read. Running an
import again adds only what is missing. Files, reactions and custom emoji of other chats
are not imported.

An import writes only into workspaces and channels that an import created. If the export
names a workspace, channel or conversation that already exists on the server and was not
created by an import (for example a workspace people already use), the import stops before
writing anything and lists them. To add to them on purpose, put `--merge` before the
source (`import --merge slack <zip> <workspace>`): people of the export then join those
existing workspaces and channels as plain members, no one's role there changes, and the
export's administrators and channel managers get no rights in them. Workspaces and
channels the import creates keep the roles of the export. Exports come from outside: an
export can make anyone a member of any workspace or channel it names, so merge only an
export you trust.

## Moving workspaces to another Cenacle server

To move a whole server to a new host, restore a backup there (see
[backup](../backup/README.md)): nothing is lost. To move **some workspaces** (to split a
server, or to merge two), export them and import them on the other server:

```sh
# On the old server (no workspace names: all of them):
docker compose … run --rm -v "$PWD:/out" server export /out/acme.zip "Acme"
# On the new server:
docker compose … run --rm -v "$PWD/acme.zip:/import.zip:ro" server import cenacle /import.zip
```

The export holds the workspaces, their people with their roles, channels and conversations
with their members, and messages with threads, reactions, pins, forum titles and tags and
their files. People are found on the new server by their Cenacle ID account when both
servers use the same Cenacle ID, else by verified address, else they get an account to
claim as above. A workspace whose name exists on the new server receives the channels,
and channels with the same name receive the messages, only with `import --merge cenacle …`
(see above: people join existing workspaces and channels as members, roles there stay). Encrypted channels stay
behind: their messages can only be read on members' devices or with the passphrase. Settings, bots, polls,
canvases, lists and workflows are not part of an export. Exports are readable by the same
or a newer Cenacle.
